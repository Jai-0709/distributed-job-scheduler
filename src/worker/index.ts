/**
 * Worker process entrypoint.
 *
 * Responsibilities:
 * 1. Register self in the Worker table on startup
 * 2. Poll all non-paused queues on a configurable interval
 * 3. Claim jobs up to concurrency limit, execute them concurrently
 * 4. Send heartbeats on a fixed interval (independent of poll loop)
 * 5. Graceful shutdown: SIGTERM/SIGINT → DRAINING → wait for in-flight → OFFLINE
 *
 * The worker never interacts with ScheduledJob rows — that is the scheduler's job.
 * The worker only processes Job rows in CLAIMED status.
 */

import os from 'os';
import { prisma } from '../shared/lib/prisma';
import { redis } from '../shared/lib/redis';
import { logger } from '../shared/lib/logger';
import { claimJobsAllQueues } from '../shared/services/jobClaim.service';
import {
  markJobRunning,
  markJobCompleted,
  markJobFailed,
} from '../shared/services/jobExecution.service';
import { getHandler } from '../shared/lib/handlers';
import type { Job, RetryPolicy } from '@prisma/client';

// ─── Configuration ────────────────────────────────────────────────────────────

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '5', 10);
const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? '2000', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? '10000', 10);
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? '30000', 10);

// ─── State ────────────────────────────────────────────────────────────────────

let workerId: string;
let isShuttingDown = false;
let inFlightJobs = new Set<string>(); // Set of jobIds currently executing
let pollTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

// ─── Startup ──────────────────────────────────────────────────────────────────

async function register(): Promise<string> {
  const worker = await prisma.worker.create({
    data: {
      hostname: os.hostname(),
      pid: process.pid,
      status: 'ONLINE',
      concurrency: CONCURRENCY,
      currentLoad: 0,
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    },
  });

  logger.info('Worker registered', {
    workerId: worker.id,
    hostname: worker.hostname,
    pid: worker.pid,
    concurrency: CONCURRENCY,
  });

  return worker.id;
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

async function sendHeartbeat(): Promise<void> {
  if (!workerId) return;

  try {
    const memUsage = process.memoryUsage();
    const memoryMb = memUsage.heapUsed / 1024 / 1024;

    await prisma.$transaction([
      prisma.worker.update({
        where: { id: workerId },
        data: {
          lastSeenAt: new Date(),
          currentLoad: inFlightJobs.size,
          status: isShuttingDown ? 'DRAINING' : 'ONLINE',
        },
      }),
      prisma.workerHeartbeat.create({
        data: {
          workerId,
          activeJobs: inFlightJobs.size,
          memoryMb,
          timestamp: new Date(),
        },
      }),
    ]);

    logger.debug('Heartbeat sent', { workerId, activeJobs: inFlightJobs.size, memoryMb });
  } catch (err) {
    logger.error('Heartbeat failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Job Execution ───────────────────────────────────────────────────────────

type JobWithPolicy = Job & {
  retryPolicy: RetryPolicy | null;
  queue: { defaultRetryPolicy: RetryPolicy | null };
};

async function executeJob(job: JobWithPolicy): Promise<void> {
  const startTime = Date.now();
  inFlightJobs.add(job.id);

  const attemptNumber = job.retryCount + 1;
  let executionId: string | null = null;

  try {
    executionId = await markJobRunning(job.id, workerId, attemptNumber);

    const handler = getHandler(job.type);
    if (!handler) {
      throw new Error(`No handler registered for job type: ${job.type}`);
    }

    // Execute the handler — idempotent by contract (see handlers/index.ts)
    await handler(job);

    const durationMs = Date.now() - startTime;
    await markJobCompleted(job.id, executionId, durationMs);

    logger.info('Job executed successfully', {
      jobId: job.id,
      type: job.type,
      durationMs,
      attempt: attemptNumber,
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    logger.warn('Job execution failed', {
      jobId: job.id,
      type: job.type,
      error: errorMessage,
      attempt: attemptNumber,
    });

    if (executionId) {
      await markJobFailed(job, executionId, errorMessage, durationMs);
    }
  } finally {
    inFlightJobs.delete(job.id);
  }
}

// ─── Poll Loop ────────────────────────────────────────────────────────────────

async function pollAndClaim(): Promise<void> {
  if (isShuttingDown) return;

  const remainingCapacity = CONCURRENCY - inFlightJobs.size;
  if (remainingCapacity <= 0) {
    logger.debug('Worker at capacity, skipping poll', {
      workerId,
      inFlight: inFlightJobs.size,
      concurrency: CONCURRENCY,
    });
    return;
  }

  try {
    const jobs = await claimJobsAllQueues(workerId, remainingCapacity);

    if (jobs.length > 0) {
      logger.info('Jobs claimed, starting execution', {
        workerId,
        count: jobs.length,
      });

      // Execute all claimed jobs concurrently — don't await, let them run in the background
      // while the poll loop continues. We track in-flight via inFlightJobs set.
      for (const job of jobs) {
        // executeJob manages its own try/catch — a failure here won't crash the worker
        executeJob(job as JobWithPolicy).catch((err) => {
          logger.error('Unexpected error in executeJob', {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
          inFlightJobs.delete(job.id);
        });
      }
    }
  } catch (err) {
    logger.error('Poll cycle failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Worker shutting down', { signal, workerId, inFlight: inFlightJobs.size });

  // Stop the poll and heartbeat loops
  if (pollTimer) clearInterval(pollTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  // Mark as DRAINING — the reaper will pick this up if we take too long
  await prisma.worker.update({
    where: { id: workerId },
    data: { status: 'DRAINING' },
  });

  // Wait for in-flight jobs to finish (with timeout)
  const shutdownDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;

  while (inFlightJobs.size > 0 && Date.now() < shutdownDeadline) {
    logger.info('Waiting for in-flight jobs', { remaining: inFlightJobs.size });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (inFlightJobs.size > 0) {
    logger.warn('Shutdown timeout reached, some jobs may be released by reaper', {
      remainingJobs: [...inFlightJobs],
    });
    // The stale-claim reaper will release these within 30s
  }

  // Mark OFFLINE and disconnect
  await prisma.worker.update({
    where: { id: workerId },
    data: { status: 'OFFLINE', currentLoad: 0 },
  });

  await prisma.$disconnect();
  redis.disconnect();

  logger.info('Worker offline', { workerId });
  process.exit(0);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.env.SERVICE_NAME = 'worker';

  logger.info('Worker starting', { concurrency: CONCURRENCY, pid: process.pid });

  workerId = await register();

  // Heartbeat loop — independent of poll loop
  await sendHeartbeat(); // immediate first heartbeat
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  // Poll loop
  pollTimer = setInterval(pollAndClaim, POLL_INTERVAL_MS);
  await pollAndClaim(); // immediate first poll

  // Graceful shutdown handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('Worker running', { workerId, pollInterval: POLL_INTERVAL_MS });
}

main().catch((err) => {
  logger.error('Worker failed to start', { error: err.message });
  process.exit(1);
});
