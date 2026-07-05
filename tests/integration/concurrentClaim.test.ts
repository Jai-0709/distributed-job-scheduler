/**
 * Integration test: concurrent job claiming.
 * ...
 */

export {}; // make this file a module to avoid top-level variable conflicts

const hasDatabaseUrl = !!process.env.DATABASE_URL;

// Skip all integration tests gracefully if DATABASE_URL is not set,
// so `npm test` never fails in a CI environment without a DB.
const describeOrSkip = hasDatabaseUrl ? describe : describe.skip;

describeOrSkip('Concurrent job claiming (integration)', () => {
  let prismaClient: any;
  let testQueueId: string;
  let testWorker1Id: string;
  let testWorker2Id: string;

  beforeAll(async () => {
    if (!hasDatabaseUrl) return;

    const { PrismaClient } = await import('@prisma/client');
    prismaClient = new PrismaClient();

    // Create test org, project, queue
    const org = await prismaClient.organization.create({
      data: { name: 'Test Org (concurrent claim test)' },
    });
    const project = await prismaClient.project.create({
      data: { name: 'Test Project', organizationId: org.id },
    });
    const queue = await prismaClient.queue.create({
      data: {
        name: `test-claim-queue-${Date.now()}`,
        concurrencyLimit: 10,
        isPaused: false,
        projectId: project.id,
      },
    });
    testQueueId = queue.id;

    // Create two fake workers
    const w1 = await prismaClient.worker.create({
      data: { hostname: 'test-host-1', pid: 10001, concurrency: 5, status: 'ONLINE' },
    });
    const w2 = await prismaClient.worker.create({
      data: { hostname: 'test-host-2', pid: 10002, concurrency: 5, status: 'ONLINE' },
    });
    testWorker1Id = w1.id;
    testWorker2Id = w2.id;

    // Seed 20 QUEUED jobs in the test queue
    await prismaClient.job.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        queueId: testQueueId,
        type: 'test-job',
        payload: { index: i },
        status: 'QUEUED',
        priority: 0,
        runAt: new Date(),
        maxRetries: 0,
      })),
    });
  });

  afterAll(async () => {
    if (!hasDatabaseUrl || !prismaClient) return;
    // Clean up: delete all jobs in the test queue, then the queue itself
    await prismaClient.job.deleteMany({ where: { queueId: testQueueId } });
    await prismaClient.queue.delete({ where: { id: testQueueId } });
    await prismaClient.$disconnect();
  });

  it('two concurrent workers claim non-overlapping sets of jobs', async () => {
    const { claimJobs } = await import('../../src/shared/services/jobClaim.service');

    // Fire both claims simultaneously — no await between them
    const [result1, result2] = await Promise.all([
      claimJobs(testQueueId, testWorker1Id, 5),
      claimJobs(testQueueId, testWorker2Id, 5),
    ]);

    const ids1 = new Set(result1.claimed.map((j: any) => j.id));
    const ids2 = new Set(result2.claimed.map((j: any) => j.id));

    // Verify both workers got some jobs
    expect(ids1.size).toBeGreaterThan(0);
    expect(ids2.size).toBeGreaterThan(0);

    // THE CRITICAL ASSERTION: no job appears in both sets
    const overlap = [...ids1].filter((id) => ids2.has(id));
    expect(overlap).toHaveLength(0);

    // Total claimed should not exceed 20 (total seeded jobs)
    expect(ids1.size + ids2.size).toBeLessThanOrEqual(20);
  });

  it('claimed jobs have status CLAIMED, not QUEUED', async () => {
    const { claimJobs } = await import('../../src/shared/services/jobClaim.service');

    const { claimed } = await claimJobs(testQueueId, testWorker1Id, 3);

    for (const job of claimed) {
      expect(job.status).toBe('CLAIMED');
      expect(job.claimedByWorkerId).toBe(testWorker1Id);
      expect(job.claimedAt).not.toBeNull();
    }
  });

  it('returns empty array when no jobs are available', async () => {
    // Create a fresh empty queue
    const org = await prismaClient.organization.create({
      data: { name: 'Empty Queue Test Org' },
    });
    const project = await prismaClient.project.create({
      data: { name: 'Empty Queue Test Project', organizationId: org.id },
    });
    const emptyQueue = await prismaClient.queue.create({
      data: {
        name: `empty-queue-${Date.now()}`,
        concurrencyLimit: 5,
        isPaused: false,
        projectId: project.id,
      },
    });

    const { claimJobs } = await import('../../src/shared/services/jobClaim.service');
    const { claimed } = await claimJobs(emptyQueue.id, testWorker1Id, 5);

    expect(claimed).toHaveLength(0);

    // Cleanup
    await prismaClient.queue.delete({ where: { id: emptyQueue.id } });
  });
});
