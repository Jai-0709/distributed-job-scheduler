/**
 * Queue management service.
 * Stats aggregation, pause/resume with Redis distributed locking.
 */

import { prisma } from '../lib/prisma';
import { acquireLock, releaseLock } from '../lib/redis';
import { logger } from '../lib/logger';
import { randomUUID } from 'crypto';

export interface QueueStats {
  queueId: string;
  queueName: string;
  isPaused: boolean;
  statusCounts: Record<string, number>;
  total: number;
  oldestQueuedJobAge: number | null; // milliseconds, null if no QUEUED jobs
}

/**
 * Get stats for a queue: job counts grouped by status + oldest queued job age.
 * The oldest-queued-job age is a backlog signal — a large age means jobs are
 * waiting longer than expected.
 */
export async function getQueueStats(queueId: string): Promise<QueueStats> {
  const queue = await prisma.queue.findUnique({
    where: { id: queueId },
    select: { id: true, name: true, isPaused: true },
  });

  if (!queue) throw new Error(`Queue ${queueId} not found`);

  // Aggregate job counts by status
  const statusGroups = await prisma.job.groupBy({
    by: ['status'],
    where: { queueId },
    _count: { id: true },
  });

  const statusCounts: Record<string, number> = {};
  let total = 0;
  for (const group of statusGroups) {
    statusCounts[group.status] = group._count.id;
    total += group._count.id;
  }

  // Find oldest QUEUED job
  const oldestQueued = await prisma.job.findFirst({
    where: { queueId, status: 'QUEUED' },
    orderBy: { runAt: 'asc' },
    select: { runAt: true },
  });

  const oldestQueuedJobAge = oldestQueued
    ? Date.now() - oldestQueued.runAt.getTime()
    : null;

  return {
    queueId: queue.id,
    queueName: queue.name,
    isPaused: queue.isPaused,
    statusCounts,
    total,
    oldestQueuedJobAge,
  };
}

/**
 * Pause a queue using a Redis distributed lock to prevent race conditions
 * between concurrent pause/resume requests.
 */
export async function pauseQueue(queueId: string): Promise<void> {
  const token = randomUUID();
  const lockKey = `queue:${queueId}:pause`;
  const acquired = await acquireLock(lockKey, token, 5000);

  if (!acquired) {
    throw new Error(`Could not acquire lock for queue ${queueId} — another operation is in progress`);
  }

  try {
    await prisma.queue.update({
      where: { id: queueId, deletedAt: null },
      data: { isPaused: true },
    });
    logger.info('Queue paused', { queueId });
  } finally {
    await releaseLock(lockKey, token);
  }
}

/**
 * Resume a queue using a Redis distributed lock.
 */
export async function resumeQueue(queueId: string): Promise<void> {
  const token = randomUUID();
  const lockKey = `queue:${queueId}:pause`;
  const acquired = await acquireLock(lockKey, token, 5000);

  if (!acquired) {
    throw new Error(`Could not acquire lock for queue ${queueId} — another operation is in progress`);
  }

  try {
    await prisma.queue.update({
      where: { id: queueId, deletedAt: null },
      data: { isPaused: false },
    });
    logger.info('Queue resumed', { queueId });
  } finally {
    await releaseLock(lockKey, token);
  }
}
