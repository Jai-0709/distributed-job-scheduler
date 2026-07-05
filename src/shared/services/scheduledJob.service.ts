/**
 * Scheduled job materialization service.
 *
 * The scheduler reads ScheduledJob rows (cron templates) and materializes
 * real Job rows when they are due. The scheduler NEVER executes jobs itself —
 * only workers do. This separation means:
 *   - Workers can scale independently of the scheduler
 *   - A scheduler crash never loses in-flight executions
 *   - The scheduler is stateless beyond the nextRunAt timestamps in Postgres
 *
 * See docs/architecture.md for the full process separation rationale.
 */

import { parseExpression } from 'cron-parser';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

type TxClient = Omit<
  Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Find all active ScheduledJobs that are due (nextRunAt <= now),
 * materialize a Job row for each, and advance nextRunAt using the cron expression.
 * Everything runs in a single transaction per scheduled job.
 */
export async function materializeDueJobs(): Promise<number> {
  const now = new Date();

  // Find all due scheduled jobs
  const dueJobs = await prisma.scheduledJob.findMany({
    where: {
      isActive: true,
      nextRunAt: { lte: now },
    },
    include: {
      queue: {
        include: { defaultRetryPolicy: true },
      },
    },
  });

  if (dueJobs.length === 0) return 0;

  let materialized = 0;

  for (const scheduledJob of dueJobs) {
    try {
      // Calculate next run time from cron expression
      const interval = parseExpression(scheduledJob.cronExpression, { currentDate: now });
      const nextRunAt = interval.next().toDate();

      await prisma.$transaction(async (tx: TxClient) => {
        // Materialize the Job row
        await tx.job.create({
          data: {
            queueId: scheduledJob.queueId,
            type: scheduledJob.jobType,
            payload: scheduledJob.payloadTemplate as object,
            status: 'QUEUED',
            priority: 0, // scheduled jobs get normal priority
            runAt: now,
            maxRetries: scheduledJob.queue.defaultRetryPolicy?.maxRetries ?? 3,
            retryPolicyId: scheduledJob.queue.defaultRetryPolicyId ?? null,
          },
        });

        // Advance nextRunAt
        await tx.scheduledJob.update({
          where: { id: scheduledJob.id },
          data: {
            lastRunAt: now,
            nextRunAt,
          },
        });
      });

      materialized++;

      logger.info('Scheduled job materialized', {
        scheduledJobId: scheduledJob.id,
        name: scheduledJob.name,
        jobType: scheduledJob.jobType,
        nextRunAt,
      });
    } catch (err) {
      logger.error('Failed to materialize scheduled job', {
        scheduledJobId: scheduledJob.id,
        name: scheduledJob.name,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue with other scheduled jobs — don't let one failure block the rest
    }
  }

  return materialized;
}
