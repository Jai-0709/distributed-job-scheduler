/**
 * Job claiming service — the concurrency-safe heart of the scheduler.
 *
 * Uses a raw SQL query inside a Prisma transaction with FOR UPDATE SKIP LOCKED:
 * - FOR UPDATE: acquires a row-level lock on each selected row
 * - SKIP LOCKED: if a row is already locked (by another worker), skip it instead
 *   of waiting. This means two workers polling simultaneously cannot claim the same
 *   job — the second worker gets a different set of jobs rather than blocking.
 *
 * Without SKIP LOCKED, concurrent workers would serialize on locked rows, collapsing
 * throughput under load. With it, each worker efficiently gets its own slice of work.
 *
 * See docs/design-decisions.md for the full justification.
 */

import type { Job } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export interface ClaimResult {
  claimed: Job[];
}

/**
 * Atomically claim up to `limit` jobs from a queue for a specific worker.
 * Runs inside a single Prisma transaction — the SELECT FOR UPDATE SKIP LOCKED
 * and the subsequent UPDATE are one atomic unit.
 *
 * @param queueId - the queue to pull from
 * @param workerId - the worker claiming the jobs
 * @param limit - max number of jobs to claim in this batch
 */
export async function claimJobs(
  queueId: string,
  workerId: string,
  limit: number,
): Promise<ClaimResult> {
  if (limit <= 0) return { claimed: [] };

  const now = new Date();

  const claimed = await prisma.$transaction(async (tx) => {
    // Raw query: SELECT with FOR UPDATE SKIP LOCKED
    // - Filters: right queue, QUEUED status, runAt <= now (not delayed)
    // - Orders: higher priority first, then FIFO by createdAt
    // - SKIP LOCKED: skip any rows another worker already locked
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Job"
      WHERE "queueId" = ${queueId}
        AND status = 'QUEUED'::"JobStatus"
        AND "runAt" <= ${now}
      ORDER BY priority DESC, "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;

    if (rows.length === 0) return [];

    const ids = rows.map((r: { id: string }) => r.id);

    // Update all claimed rows atomically within the same transaction
    await tx.job.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'CLAIMED',
        claimedByWorkerId: workerId,
        claimedAt: now,
      },
    });

    // Return the full updated rows
    return tx.job.findMany({
      where: { id: { in: ids } },
      include: { retryPolicy: true, queue: { include: { defaultRetryPolicy: true } } },
    });
  });

  if (claimed.length > 0) {
    logger.info('Jobs claimed', {
      workerId,
      queueId,
      count: claimed.length,
      jobIds: claimed.map((j: Job) => j.id),
    });
  }

  return { claimed };
}

/**
 * Claim jobs across ALL non-paused queues for a worker.
 * Distributes the concurrency budget evenly across queues.
 *
 * @param workerId - the worker claiming
 * @param remainingCapacity - total slots available (concurrency - currentLoad)
 */
export async function claimJobsAllQueues(
  workerId: string,
  remainingCapacity: number,
): Promise<Job[]> {
  if (remainingCapacity <= 0) return [];

  // Find all active (non-paused, non-deleted) queues
  const queues = await prisma.queue.findMany({
    where: { isPaused: false, deletedAt: null },
    select: { id: true, concurrencyLimit: true },
  });

  if (queues.length === 0) return [];

  const allClaimed: Job[] = [];
  let remaining = remainingCapacity;

  for (const queue of queues) {
    if (remaining <= 0) break;
    // Take up to the queue's own concurrency limit, but no more than remaining capacity
    const limit = Math.min(queue.concurrencyLimit, remaining);
    const { claimed } = await claimJobs(queue.id, workerId, limit);
    allClaimed.push(...claimed);
    remaining -= claimed.length;
  }

  return allClaimed;
}
