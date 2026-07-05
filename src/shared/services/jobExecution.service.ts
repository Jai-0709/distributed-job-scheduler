/**
 * Job execution lifecycle service.
 *
 * Manages transitions through the job lifecycle:
 *   CLAIMED → RUNNING → COMPLETED
 *                    ↘ FAILED → QUEUED (retry, with delay)
 *                            ↘ DEAD_LETTER (retries exhausted)
 *
 * Key design: Job holds "current state"; JobExecution holds "what happened,
 * attempt by attempt." This separation matters because:
 *   - A single Job can have many JobExecution rows (one per attempt)
 *   - Querying "where is this job now?" hits Job.status (indexed)
 *   - Querying "what happened on attempt 3?" hits JobExecution (append-only log)
 *   - Different access patterns → different tables (see design-decisions.md)
 *
 * The DLQ write and the job status update happen in the same transaction to
 * guarantee we never have a Job in DEAD_LETTER with no matching DLQ record,
 * or a DLQ record with no matching job update.
 */

import type { Job, RetryPolicy } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import {
  calculateRetryDelay,
  shouldRetry,
  RetryStrategy,
} from './retryPolicy.service';

type JobWithRetryPolicy = Job & {
  retryPolicy: RetryPolicy | null;
  queue: {
    defaultRetryPolicy: RetryPolicy | null;
  };
};

type TxClient = Omit<
  Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Resolve the effective retry policy for a job.
 * Job-level policy overrides queue default.
 */
function resolveRetryPolicy(job: JobWithRetryPolicy): RetryPolicy | null {
  return job.retryPolicy ?? (job.queue as any).defaultRetryPolicy ?? null;
}

/**
 * Mark a job as RUNNING and create a JobExecution row.
 * Returns the new execution ID for tracking.
 */
export async function markJobRunning(
  jobId: string,
  workerId: string,
  attemptNumber: number,
): Promise<string> {
  const now = new Date();

  let executionId = '';

  await prisma.$transaction(async (tx: TxClient) => {
    const execution = await tx.jobExecution.create({
      data: {
        jobId,
        workerId,
        attemptNumber,
        status: 'RUNNING',
        startedAt: now,
      },
    });
    executionId = execution.id;

    await tx.job.update({
      where: { id: jobId },
      data: {
        status: 'RUNNING',
        startedAt: now,
        claimedByWorkerId: workerId,
      },
    });

    await tx.jobLog.create({
      data: {
        jobId,
        level: 'INFO',
        message: `Job started (attempt ${attemptNumber})`,
        meta: { workerId, attemptNumber },
      },
    });
  });

  return executionId;
}

/**
 * Mark a job as COMPLETED.
 */
export async function markJobCompleted(
  jobId: string,
  executionId: string,
  durationMs: number,
): Promise<void> {
  const now = new Date();

  await prisma.$transaction(async (tx: TxClient) => {
    await tx.jobExecution.update({
      where: { id: executionId },
      data: {
        status: 'SUCCEEDED',
        finishedAt: now,
        durationMs,
      },
    });

    await tx.job.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        completedAt: now,
      },
    });

    await tx.jobLog.create({
      data: {
        jobId,
        executionId,
        level: 'INFO',
        message: 'Job completed successfully',
        meta: { durationMs },
      },
    });
  });

  logger.info('Job completed', { jobId, executionId, durationMs });
}

/**
 * Mark a job as FAILED and either re-queue (with delay) or move to DEAD_LETTER.
 *
 * The retry delay is computed from the resolved retry policy.
 * The DLQ write happens in the same transaction as the status update —
 * there can never be a job in DEAD_LETTER with no DLQ record.
 */
export async function markJobFailed(
  job: JobWithRetryPolicy,
  executionId: string,
  errorMessage: string,
  durationMs: number,
): Promise<void> {
  const now = new Date();
  const newRetryCount = job.retryCount + 1;
  const policy = resolveRetryPolicy(job);
  const maxRetries = policy?.maxRetries ?? job.maxRetries;

  if (shouldRetry(newRetryCount - 1, maxRetries)) {
    // Calculate delay for the next attempt
    const delayMs = policy
      ? calculateRetryDelay({
          strategy: policy.strategy as RetryStrategy,
          baseDelayMs: policy.baseDelayMs,
          maxDelayMs: policy.maxDelayMs,
          multiplier: policy.multiplier,
          attemptNumber: newRetryCount,
        })
      : 5000; // fallback: 5s fixed if no policy

    const runAt = new Date(now.getTime() + delayMs);

    await prisma.$transaction(async (tx: TxClient) => {
      await tx.jobExecution.update({
        where: { id: executionId },
        data: {
          status: 'FAILED',
          finishedAt: now,
          durationMs,
          errorMessage,
        },
      });

      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'QUEUED', // back to QUEUED for retry
          retryCount: newRetryCount,
          lastFailureReason: errorMessage,
          runAt,         // delayed retry
          claimedByWorkerId: null,
          claimedAt: null,
          startedAt: null,
        },
      });

      await tx.jobLog.create({
        data: {
          jobId: job.id,
          executionId,
          level: 'WARN',
          message: `Job failed, retry ${newRetryCount}/${maxRetries} scheduled in ${Math.round(delayMs)}ms`,
          meta: { errorMessage, retryCount: newRetryCount, runAt, delayMs },
        },
      });
    });

    logger.warn('Job failed — retrying', {
      jobId: job.id,
      retryCount: newRetryCount,
      maxRetries,
      runAt,
      delayMs,
    });
  } else {
    // Retries exhausted → DEAD_LETTER
    // DLQ and Job update happen in the same transaction — atomically consistent.
    await prisma.$transaction(async (tx: TxClient) => {
      await tx.jobExecution.update({
        where: { id: executionId },
        data: {
          status: 'FAILED',
          finishedAt: now,
          durationMs,
          errorMessage,
        },
      });

      await tx.job.update({
        where: { id: job.id },
        data: {
          status: 'DEAD_LETTER',
          retryCount: newRetryCount,
          lastFailureReason: errorMessage,
          completedAt: now,
          claimedByWorkerId: null,
          claimedAt: null,
        },
      });

      // payloadSnapshot is an IMMUTABLE COPY — not a live reference.
      // This is crucial: DLQ forensics must survive even if the Job row is later purged.
      await tx.deadLetterQueue.create({
        data: {
          jobId: job.id,
          queueId: job.queueId,
          payloadSnapshot: job.payload as object,
          reason: errorMessage,
          failedAt: now,
        },
      });

      await tx.jobLog.create({
        data: {
          jobId: job.id,
          executionId,
          level: 'ERROR',
          message: `Job exhausted all retries (${maxRetries}) — moved to DEAD_LETTER`,
          meta: { errorMessage, retryCount: newRetryCount, maxRetries },
        },
      });
    });

    logger.error('Job moved to DEAD_LETTER', {
      jobId: job.id,
      retryCount: newRetryCount,
      maxRetries,
      errorMessage,
    });
  }
}

/**
 * Retry a job from FAILED or DEAD_LETTER status.
 * Resets retry count, re-queues immediately.
 * If the job has a DLQ record, marks retriedFromDlqAt.
 */
export async function retryJobFromDlq(jobId: string): Promise<Job> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { deadLetter: true },
  });

  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status !== 'FAILED' && job.status !== 'DEAD_LETTER') {
    throw new Error(`Job ${jobId} is not in FAILED or DEAD_LETTER status (current: ${job.status})`);
  }

  const now = new Date();
  const hasDlq = !!job.deadLetter;

  let updatedJob!: Job;

  await prisma.$transaction(async (tx: TxClient) => {
    updatedJob = await tx.job.update({
      where: { id: jobId },
      data: {
        status: 'QUEUED',
        retryCount: 0,
        lastFailureReason: null,
        runAt: now,
        claimedByWorkerId: null,
        claimedAt: null,
        startedAt: null,
        completedAt: null,
      },
    });

    if (hasDlq) {
      await tx.deadLetterQueue.update({
        where: { jobId },
        data: { retriedFromDlqAt: now },
      });
    }

    await tx.jobLog.create({
      data: {
        jobId,
        level: 'INFO',
        message: 'Job manually retried from DLQ',
        meta: { previousStatus: job.status, retriedAt: now },
      },
    });
  });

  logger.info('Job retried from DLQ', { jobId, previousStatus: job.status });
  return updatedJob;
}
