/**
 * Seed script: creates one demo org, admin user, project, queue with exponential
 * retry policy, ~15 demo jobs, and one scheduled job.
 *
 * Run with: npx ts-node prisma/seed.ts
 * Or via:   npm run db:seed
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { parseExpression } from 'cron-parser';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // ── Organization ─────────────────────────────────────────────────────────
  const org = await prisma.organization.upsert({
    where: { id: 'seed-org-001' },
    update: {},
    create: {
      id: 'seed-org-001',
      name: 'Demo Organization',
    },
  });
  console.log(`✓ Organization: ${org.name}`);

  // ── Admin User ───────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('password123', 10);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@demo.com' },
    update: {},
    create: {
      id: 'seed-user-001',
      email: 'admin@demo.com',
      passwordHash,
      name: 'Demo Admin',
      role: 'ADMIN',
      organizationId: org.id,
    },
  });
  console.log(`✓ Admin user: ${adminUser.email}`);

  // ── Member User ──────────────────────────────────────────────────────────
  const memberPasswordHash = await bcrypt.hash('member123', 10);
  await prisma.user.upsert({
    where: { email: 'member@demo.com' },
    update: {},
    create: {
      id: 'seed-user-002',
      email: 'member@demo.com',
      passwordHash: memberPasswordHash,
      name: 'Demo Member',
      role: 'MEMBER',
      organizationId: org.id,
    },
  });
  console.log(`✓ Member user: member@demo.com`);

  // ── Project ──────────────────────────────────────────────────────────────
  const project = await prisma.project.upsert({
    where: { organizationId_name: { organizationId: org.id, name: 'Demo Project' } },
    update: {},
    create: {
      id: 'seed-project-001',
      name: 'Demo Project',
      description: 'Demo project for testing the distributed job scheduler',
      organizationId: org.id,
    },
  });
  console.log(`✓ Project: ${project.name}`);

  // ── Retry Policies ───────────────────────────────────────────────────────
  const exponentialRetryPolicy = await prisma.retryPolicy.upsert({
    where: { id: 'seed-retry-exp-001' },
    update: {},
    create: {
      id: 'seed-retry-exp-001',
      name: 'Exponential Backoff (default)',
      strategy: 'EXPONENTIAL' as any,
      maxRetries: 3,
      baseDelayMs: 1000,    // 1s base
      maxDelayMs: 30000,    // 30s cap
      multiplier: 2.0,
    },
  });

  const fixedRetryPolicy = await prisma.retryPolicy.upsert({
    where: { id: 'seed-retry-fixed-001' },
    update: {},
    create: {
      id: 'seed-retry-fixed-001',
      name: 'Fixed 2s Retry',
      strategy: 'FIXED' as any,
      maxRetries: 2,
      baseDelayMs: 2000,
      maxDelayMs: 2000,
      multiplier: 1.0,
    },
  });
  console.log(`✓ Retry policies: exponential + fixed`);

  // ── Queue ────────────────────────────────────────────────────────────────
  const queue = await prisma.queue.upsert({
    where: { projectId_name: { projectId: project.id, name: 'default' } },
    update: {},
    create: {
      id: 'seed-queue-001',
      name: 'default',
      concurrencyLimit: 5,
      isPaused: false,
      projectId: project.id,
      defaultRetryPolicyId: exponentialRetryPolicy.id,
    },
  });

  const emailQueue = await prisma.queue.upsert({
    where: { projectId_name: { projectId: project.id, name: 'email' } },
    update: {},
    create: {
      id: 'seed-queue-002',
      name: 'email',
      concurrencyLimit: 3,
      isPaused: false,
      projectId: project.id,
      defaultRetryPolicyId: fixedRetryPolicy.id,
    },
  });
  console.log(`✓ Queues: default + email`);

  // ── Demo Jobs ────────────────────────────────────────────────────────────
  // Mix of job types:
  // - send-email: always succeeds quickly
  // - generate-report: always succeeds with brief delay
  // - flaky-job: fails randomly (to demo retry → DLQ path)

  const now = new Date();

  interface JobSeed {
    type: string;
    payload: Record<string, unknown>;
    priority: number;
    maxRetries: number;
    retryPolicyId: string;
    status: string;
    idempotencyKey?: string;
    queueId?: string;
  }

  const jobSeeds: JobSeed[] = [
    // Immediately queued jobs on default queue
    {
      type: 'send-email',
      payload: { to: 'user1@example.com', subject: 'Welcome!', template: 'welcome' },
      priority: 5,
      maxRetries: 2,
      retryPolicyId: fixedRetryPolicy.id,
      idempotencyKey: 'welcome-email-user1',
      status: 'QUEUED' as any,
    },
    {
      type: 'send-email',
      payload: { to: 'user2@example.com', subject: 'Your weekly report', template: 'weekly-report' },
      priority: 3,
      maxRetries: 2,
      retryPolicyId: fixedRetryPolicy.id,
      idempotencyKey: 'weekly-email-user2',
      status: 'QUEUED' as any,
    },
    {
      type: 'generate-report',
      payload: { reportId: 'rpt-001', format: 'pdf', userId: adminUser.id },
      priority: 8,
      maxRetries: 3,
      retryPolicyId: exponentialRetryPolicy.id,
      status: 'QUEUED' as any,
    },
    {
      type: 'generate-report',
      payload: { reportId: 'rpt-002', format: 'csv', userId: adminUser.id },
      priority: 6,
      maxRetries: 3,
      retryPolicyId: exponentialRetryPolicy.id,
      status: 'QUEUED' as any,
    },
    {
      type: 'flaky-job',
      payload: { taskId: 'task-001', failProbability: 0.9 },
      priority: 4,
      maxRetries: 3,
      retryPolicyId: exponentialRetryPolicy.id,
      status: 'QUEUED' as any,
    },
    {
      type: 'flaky-job',
      payload: { taskId: 'task-002', failProbability: 0.9 },
      priority: 4,
      maxRetries: 3,
      retryPolicyId: exponentialRetryPolicy.id,
      status: 'QUEUED' as any,
    },
    {
      type: 'flaky-job',
      payload: { taskId: 'task-003', failProbability: 1.0 }, // always fails → hits DLQ
      priority: 2,
      maxRetries: 2,
      retryPolicyId: fixedRetryPolicy.id,
      status: 'QUEUED' as any,
    },
    {
      type: 'send-email',
      payload: { to: 'user3@example.com', subject: 'Notification', template: 'notification' },
      priority: 1,
      maxRetries: 2,
      retryPolicyId: fixedRetryPolicy.id,
      status: 'QUEUED' as any,
    },
    {
      type: 'generate-report',
      payload: { reportId: 'rpt-003', format: 'xlsx', userId: adminUser.id },
      priority: 7,
      maxRetries: 3,
      retryPolicyId: exponentialRetryPolicy.id,
      status: 'QUEUED' as any,
    },
    // Scheduled for the future (delayed jobs)
    {
      type: 'send-email',
      payload: { to: 'user4@example.com', subject: 'Scheduled reminder', template: 'reminder' },
      priority: 2,
      maxRetries: 2,
      retryPolicyId: fixedRetryPolicy.id,
      status: 'SCHEDULED' as any,
    },
    // Email queue jobs
    {
      type: 'send-email',
      payload: { to: 'newsletter@example.com', subject: 'Newsletter Q2', template: 'newsletter' },
      priority: 3,
      maxRetries: 2,
      retryPolicyId: fixedRetryPolicy.id,
      queueId: emailQueue.id,
      status: 'QUEUED' as any,
    },
    {
      type: 'send-email',
      payload: { to: 'bulk@example.com', subject: 'Bulk campaign', template: 'campaign' },
      priority: 1,
      maxRetries: 2,
      retryPolicyId: fixedRetryPolicy.id,
      queueId: emailQueue.id,
      status: 'QUEUED' as any,
    },
    {
      type: 'flaky-job',
      payload: { taskId: 'task-004', failProbability: 0.8 },
      priority: 3,
      maxRetries: 3,
      retryPolicyId: exponentialRetryPolicy.id,
      status: 'QUEUED' as any,
    },
    {
      type: 'generate-report',
      payload: { reportId: 'rpt-004', format: 'pdf', userId: adminUser.id },
      priority: 9,
      maxRetries: 3,
      retryPolicyId: exponentialRetryPolicy.id,
      status: 'QUEUED' as any,
    },
    {
      type: 'send-email',
      payload: { to: 'admin@demo.com', subject: 'System health check', template: 'health' },
      priority: 10,
      maxRetries: 1,
      retryPolicyId: fixedRetryPolicy.id,
      idempotencyKey: 'health-check-daily',
      status: 'QUEUED' as any,
    },
  ];

  let jobCount = 0;
  for (const seed of jobSeeds) {
    const queueId = seed.queueId ?? queue.id;
    // Calculate runAt: scheduled jobs get a future timestamp
    const runAt = seed.status === 'SCHEDULED' as any
      ? new Date(now.getTime() + 60 * 60 * 1000) // 1 hour from now
      : now;

    await prisma.job.create({
      data: {
        type: seed.type,
        payload: seed.payload as object,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: seed.status as any,
        priority: seed.priority,
        maxRetries: seed.maxRetries,
        retryCount: 0,
        idempotencyKey: seed.idempotencyKey ?? null,
        runAt,
        queueId,
        retryPolicyId: seed.retryPolicyId,
      },
    });
    jobCount++;
  }
  console.log(`✓ Demo jobs: ${jobCount} created`);

  // ── Scheduled Job (cron template) ────────────────────────────────────────
  // The scheduler process reads this and materializes real Job rows when due.
  const cronExpr = '* * * * *'; // every minute
  const interval = parseExpression(cronExpr);
  const nextRunAt = interval.next().toDate();

  await prisma.scheduledJob.upsert({
    where: { id: 'seed-scheduled-001' },
    update: { nextRunAt },
    create: {
      id: 'seed-scheduled-001',
      name: 'Minutely Health Check',
      cronExpression: cronExpr,
      jobType: 'send-email',
      payloadTemplate: {
        to: 'admin@demo.com',
        subject: 'Scheduled health check',
        template: 'health',
        _scheduled: true,
      },
      isActive: true,
      nextRunAt,
      queueId: queue.id,
    },
  });
  console.log(`✓ ScheduledJob: "Minutely Health Check" (cron: ${cronExpr})`);

  console.log('\n✅ Seed complete!');
  console.log('   Login: admin@demo.com / password123');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
