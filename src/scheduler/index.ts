/**
 * Scheduler process entrypoint.
 *
 * Two responsibilities only:
 * 1. Every ~30s: materialize Job rows from due ScheduledJob templates
 * 2. Every ~15s: run the stale-claim reaper
 *
 * The scheduler NEVER executes jobs itself. Workers do that.
 * This separation is documented in docs/architecture.md:
 *   - Workers scale independently of the scheduler
 *   - A scheduler crash never loses in-flight executions
 *   - The scheduler is stateless beyond nextRunAt timestamps in Postgres
 */

import { prisma } from '../shared/lib/prisma';
import { redis } from '../shared/lib/redis';
import { logger } from '../shared/lib/logger';
import { materializeDueJobs } from '../shared/services/scheduledJob.service';
import { runReaper } from '../shared/services/reaper.service';

const CRON_INTERVAL_MS = parseInt(process.env.SCHEDULER_CRON_INTERVAL_MS ?? '30000', 10);
const REAPER_INTERVAL_MS = parseInt(process.env.SCHEDULER_REAPER_INTERVAL_MS ?? '15000', 10);

let isShuttingDown = false;
let cronTimer: NodeJS.Timeout | null = null;
let reaperTimer: NodeJS.Timeout | null = null;

// ─── Cron materialization loop ────────────────────────────────────────────────

async function runCronMaterialization(): Promise<void> {
  if (isShuttingDown) return;

  try {
    const count = await materializeDueJobs();
    if (count > 0) {
      logger.info('Scheduler: materialized jobs', { count });
    } else {
      logger.debug('Scheduler: no due scheduled jobs');
    }
  } catch (err) {
    logger.error('Scheduler: cron materialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Reaper loop ──────────────────────────────────────────────────────────────

async function runReaperCycle(): Promise<void> {
  if (isShuttingDown) return;

  try {
    await runReaper();
  } catch (err) {
    logger.error('Scheduler: reaper cycle failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Scheduler shutting down', { signal });

  if (cronTimer) clearInterval(cronTimer);
  if (reaperTimer) clearInterval(reaperTimer);

  await prisma.$disconnect();
  redis.disconnect();

  logger.info('Scheduler offline');
  process.exit(0);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.env.SERVICE_NAME = 'scheduler';

  logger.info('Scheduler starting', {
    cronIntervalMs: CRON_INTERVAL_MS,
    reaperIntervalMs: REAPER_INTERVAL_MS,
    pid: process.pid,
  });

  // Run both immediately on startup
  await runCronMaterialization();
  await runReaperCycle();

  // Then run on intervals
  cronTimer = setInterval(runCronMaterialization, CRON_INTERVAL_MS);
  reaperTimer = setInterval(runReaperCycle, REAPER_INTERVAL_MS);

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('Scheduler running', {
    cronIntervalMs: CRON_INTERVAL_MS,
    reaperIntervalMs: REAPER_INTERVAL_MS,
  });
}

main().catch((err) => {
  logger.error('Scheduler failed to start', { error: err.message });
  process.exit(1);
});
