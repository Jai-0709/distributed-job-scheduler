/**
 * Job handler registry.
 *
 * Maps job.type strings to handler functions.
 * Handlers are idempotent by design — the worker may call a handler more than
 * once for the same job (on retry), so handlers must tolerate re-execution.
 * See docs/design-decisions.md for the idempotency contract.
 */

import type { Job } from '@prisma/client';
import { logger } from '../logger';

export type JobHandler = (job: Job) => Promise<void>;

const registry = new Map<string, JobHandler>();

export function registerHandler(type: string, handler: JobHandler): void {
  registry.set(type, handler);
}

export function getHandler(type: string): JobHandler | undefined {
  return registry.get(type);
}

// ── Handler implementations ──────────────────────────────────────────────────

/**
 * send-email: simulates sending an email.
 * Always succeeds — used to demonstrate the happy path.
 * Idempotency: in production this would check a sent-email audit table before
 * actually calling the mail provider. Here we simulate that check.
 */
registerHandler('send-email', async (job: Job) => {
  const payload = job.payload as { to: string; subject: string; template: string };
  logger.info('Sending email', { jobId: job.id, to: payload.to, subject: payload.subject });

  // Simulate network latency
  await sleep(200 + Math.random() * 300);

  logger.info('Email sent', { jobId: job.id, to: payload.to });
  // In production: check an outbox table first to avoid duplicate sends
});

/**
 * generate-report: simulates generating a PDF/CSV report.
 * Always succeeds — demonstrates a longer-running job.
 */
registerHandler('generate-report', async (job: Job) => {
  const payload = job.payload as { reportId: string; format: string; userId: string };
  logger.info('Generating report', { jobId: job.id, reportId: payload.reportId, format: payload.format });

  // Simulate report generation time (500ms–1.5s)
  await sleep(500 + Math.random() * 1000);

  logger.info('Report generated', { jobId: job.id, reportId: payload.reportId });
});

/**
 * flaky-job: randomly fails based on `failProbability` in the payload.
 * Used to demonstrate the retry → DLQ path.
 * Set failProbability: 1.0 to guarantee DLQ for demo purposes.
 */
registerHandler('flaky-job', async (job: Job) => {
  const payload = job.payload as { taskId: string; failProbability: number };
  const { taskId, failProbability } = payload;

  logger.info('Running flaky job', { jobId: job.id, taskId, failProbability, retryCount: job.retryCount });

  await sleep(100 + Math.random() * 200);

  if (Math.random() < failProbability) {
    throw new Error(`Flaky job ${taskId} failed on attempt ${job.retryCount + 1} (simulated failure)`);
  }

  logger.info('Flaky job succeeded', { jobId: job.id, taskId });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
