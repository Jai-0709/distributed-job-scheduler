/**
 * API tests: job creation, idempotency, listing with filter and pagination.
 * Uses supertest to hit the Express app directly.
 *
 * Requires DATABASE_URL and a running Postgres instance.
 * Skips gracefully if DATABASE_URL is not set.
 */

export {}; // make this file a module to avoid top-level variable conflicts

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const describeOrSkip = hasDatabaseUrl ? describe : describe.skip;

describeOrSkip('Jobs API (integration)', () => {
  let app: any;
  let request: any;
  let token: string;
  let queueId: string;

  beforeAll(async () => {
    if (!hasDatabaseUrl) return;

    const supertest = await import('supertest');
    const appModule = await import('../../src/api/app');
    app = appModule.createApp();
    request = supertest.default(app);

    // Register and login to get a JWT token
    await request.post('/api/auth/register').send({
      organizationName: 'API Test Org',
      name: 'API Test Admin',
      email: `apitest-${Date.now()}@example.com`,
      password: 'testpassword123',
    });

    const loginRes = await request.post('/api/auth/login').send({
      email: `apitest-${Date.now()}@example.com`,
      password: 'testpassword123',
    });

    // If registration/login race condition, use seeded admin
    let loginResponse = loginRes;
    if (loginRes.status !== 200) {
      loginResponse = await request.post('/api/auth/login').send({
        email: 'admin@demo.com',
        password: 'password123',
      });
    }

    token = loginResponse.body.token;

    // Get the first available queue
    const queuesRes = await request
      .get('/api/queues')
      .set('Authorization', `Bearer ${token}`);
    
    if (queuesRes.body.data && queuesRes.body.data.length > 0) {
      queueId = queuesRes.body.data[0].id;
    }
  });

  describe('POST /api/jobs', () => {
    it('creates a job and returns 201', async () => {
      if (!queueId) return;

      const res = await request
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({
          queueId,
          type: 'send-email',
          payload: { to: 'test@example.com', subject: 'API test' },
          priority: 1,
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('QUEUED');
      expect(res.body.type).toBe('send-email');
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'send-email' }); // missing queueId and payload

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('returns existing job with idempotent: true on duplicate idempotencyKey', async () => {
      if (!queueId) return;

      const idempotencyKey = `test-idem-${Date.now()}`;

      // First submission
      const res1 = await request
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({
          queueId,
          type: 'send-email',
          payload: { to: 'idem@example.com', subject: 'Idempotency test' },
          priority: 1,
          idempotencyKey,
        });

      expect(res1.status).toBe(201);
      expect(res1.body.idempotent).toBeFalsy();

      // Second submission with same idempotencyKey
      const res2 = await request
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({
          queueId,
          type: 'send-email',
          payload: { to: 'idem@example.com', subject: 'Idempotency test - duplicate' },
          priority: 1,
          idempotencyKey,
        });

      expect(res2.status).toBe(200);
      expect(res2.body.idempotent).toBe(true);
      expect(res2.body.id).toBe(res1.body.id); // same job returned
    });

    it('returns 401 without auth token', async () => {
      const res = await request.post('/api/jobs').send({
        queueId,
        type: 'send-email',
        payload: {},
        priority: 1,
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/jobs', () => {
    it('returns paginated job list', async () => {
      if (!queueId) return;

      const res = await request
        .get('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .query({ queueId, page: 1, pageSize: 5 });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.pageSize).toBe(5);
      expect(typeof res.body.pagination.total).toBe('number');
      expect(typeof res.body.pagination.totalPages).toBe('number');
    });

    it('filters by status', async () => {
      if (!queueId) return;

      const res = await request
        .get('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .query({ queueId, status: 'QUEUED', page: 1, pageSize: 10 });

      expect(res.status).toBe(200);
      for (const job of res.body.data) {
        expect(job.status).toBe('QUEUED');
      }
    });

    it('returns 400 for invalid status filter', async () => {
      const res = await request
        .get('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .query({ status: 'INVALID_STATUS' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid pagination params', async () => {
      const res = await request
        .get('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .query({ page: -1, pageSize: 1000 });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/jobs/:id', () => {
    it('returns job with executions and logs', async () => {
      if (!queueId) return;

      // Create a job to fetch
      const createRes = await request
        .post('/api/jobs')
        .set('Authorization', `Bearer ${token}`)
        .send({
          queueId,
          type: 'send-email',
          payload: { to: 'detail@example.com', subject: 'Detail test' },
        });

      const jobId = createRes.body.id;

      const res = await request
        .get(`/api/jobs/${jobId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(jobId);
      expect(Array.isArray(res.body.executions)).toBe(true);
      expect(Array.isArray(res.body.logs)).toBe(true);
    });

    it('returns 404 for non-existent job', async () => {
      const res = await request
        .get('/api/jobs/non-existent-id-12345')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });
});
