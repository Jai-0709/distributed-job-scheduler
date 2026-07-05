/**
 * Stale-claim reaper service.
 *
 * A worker can crash mid-job, leaving jobs stuck in CLAIMED or RUNNING status
 * with no heartbeat. Without a reaper, those jobs stay stuck forever.
 *
 * This reaper runs on the scheduler process every ~15 seconds:
 * 1. Finds workers with lastSeenAt older than STALE_THRESHOLD_MS (default 30s)
 * 2. Marks those workers OFFLINE
 * 3. Releases any jobs in CLAIMED or RUNNING status under them back to QUEUED
 *
 * This is a core reliability guarantee — explicitly documented in architecture.md.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const STALE_THRESHOLD_MS = parseInt(
  process.env.WORKER_STALE_THRESHOLD_MS ?? '30000',
  10,
);

type TxClient = Omit<
  Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export async function runReaper(): Promise<void> {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  // Find stale workers (ONLINE or DRAINING but not heard from recently)
  const staleWorkers = await prisma.worker.findMany({
    where: {
      status: { in: ['ONLINE', 'DRAINING'] },
      lastSeenAt: { lt: staleThreshold },
    },
    select: { id: true, hostname: true, pid: true, lastSeenAt: true },
  });

  if (staleWorkers.length === 0) return;

  const staleWorkerIds = staleWorkers.map((w) => w.id);

  logger.warn('Reaper found stale workers', {
    count: staleWorkers.length,
    workers: staleWorkers.map((w) => ({
      id: w.id,
      hostname: w.hostname,
      pid: w.pid,
      lastSeenAt: w.lastSeenAt,
    })),
  });

  // Run in a transaction: mark workers OFFLINE and release their jobs atomically
  await prisma.$transaction(async (tx: TxClient) => {
    // Mark stale workers as OFFLINE
    await tx.worker.updateMany({
      where: { id: { in: staleWorkerIds } },
      data: {
        status: 'OFFLINE',
        currentLoad: 0,
      },
    });

    // Find jobs stuck under stale workers
    const stuckJobs = await tx.job.findMany({
      where: {
        claimedByWorkerId: { in: staleWorkerIds },
        status: { in: ['CLAIMED', 'RUNNING'] },
      },
      select: { id: true, status: true, claimedByWorkerId: true },
    });

    if (stuckJobs.length > 0) {
      // Release jobs back to QUEUED
      await tx.job.updateMany({
        where: { id: { in: stuckJobs.map((j) => j.id) } },
        data: {
          status: 'QUEUED',
          claimedByWorkerId: null,
          claimedAt: null,
          startedAt: null,
          runAt: new Date(), // available immediately
        },
      });

      // Log each released job
      await tx.jobLog.createMany({
        data: stuckJobs.map((j) => ({
          jobId: j.id,
          level: 'WARN' as const,
          message: 'Job released by reaper — worker was stale',
          meta: {
            workerId: j.claimedByWorkerId,
            previousStatus: j.status,
            releasedAt: new Date(),
          },
          createdAt: new Date(),
        })),
      });

      logger.warn('Reaper released stuck jobs', {
        count: stuckJobs.length,
        jobIds: stuckJobs.map((j) => j.id),
      });
    }
  });

  logger.info('Reaper run complete', {
    staleWorkersMarked: staleWorkers.length,
  });
}
