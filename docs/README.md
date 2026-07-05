# Distributed Job Scheduler

A production-grade distributed background job scheduling platform with multiple workers, Postgres-backed queues, retries, dead-letter handling, live worker health monitoring, and a management dashboard.

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express + TypeScript |
| ORM | Prisma |
| Database | PostgreSQL 16 |
| Cache / Locks | Redis 7 (ioredis) |
| Frontend | React + Vite + TypeScript + Tailwind CSS |
| Auth | JWT (bcrypt, cost 10) |
| Validation | Zod |
| Testing | Jest + supertest |
| Containerization | Docker Compose |
| Cron | cron-parser |
| Logging | winston (structured JSON) |

---

## Quick Start

### 1. Prerequisites
- Docker Desktop (for Postgres + Redis)
- Node.js ≥ 20
- npm ≥ 10

### 2. Start infrastructure

```bash
docker-compose up -d
```

Wait for both containers to be healthy:
```bash
docker-compose ps
```

### 3. Install dependencies

```bash
# Root (backend)
npm install

# Dashboard
cd dashboard && npm install && cd ..
```

### 4. Configure environment

```bash
cp .env.example .env
# .env is pre-filled with docker-compose defaults — no changes needed for local dev
```

### 5. Database setup

```bash
# Run migrations (creates all tables)
npx prisma migrate dev --name init

# Generate Prisma client
npx prisma generate

# Seed demo data (org, admin user, jobs, scheduled job)
npx prisma db seed
```

> **Demo credentials:** `admin@demo.com` / `password123`

### 6. Run the three processes (each in a separate terminal)

```bash
# Terminal 1 — API server (port 4000)
npm run dev:api

# Terminal 2 — Worker process
npm run dev:worker

# Terminal 3 — Scheduler process (cron materializer + stale-claim reaper)
npm run dev:scheduler
```

### 7. Run the dashboard

```bash
cd dashboard
npm run dev
# Open http://localhost:5173
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://jobscheduler:jobscheduler_secret@localhost:5432/jobscheduler` | Postgres connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `JWT_SECRET` | *(set this in prod)* | JWT signing secret (≥32 chars) |
| `JWT_EXPIRES_IN` | `7d` | JWT token expiry |
| `BCRYPT_ROUNDS` | `10` | bcrypt cost factor |
| `PORT` | `4000` | API server port |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | `200` | Max requests per window |
| `WORKER_CONCURRENCY` | `5` | Max concurrent jobs per worker |
| `WORKER_POLL_INTERVAL_MS` | `2000` | How often the worker polls for jobs |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `10000` | Heartbeat interval |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `30000` | Grace period on SIGTERM |
| `SCHEDULER_CRON_INTERVAL_MS` | `30000` | Cron materialization interval |
| `SCHEDULER_REAPER_INTERVAL_MS` | `15000` | Stale-claim reaper interval |
| `WORKER_STALE_THRESHOLD_MS` | `30000` | How old a heartbeat must be before worker is reaped |
| `LOG_LEVEL` | `info` | Winston log level |

---

## Running Tests

```bash
# Unit tests only — no DB or Redis required, runs instantly
npm test tests/unit

# All tests (unit + integration + API) — requires a running Postgres
DATABASE_URL="postgresql://jobscheduler:jobscheduler_secret@localhost:5432/jobscheduler" npm test

# Individual test categories
npm run test:unit          # zero-dependency unit tests
npm run test:integration   # concurrent claim test (needs DB)
npm run test:api           # supertest API tests (needs DB)
```

> Integration and API tests skip gracefully via `describe.skip` if `DATABASE_URL` is not set, so `npm test` always passes in environments without a DB.

---

## Project Structure

```
/prisma/
  schema.prisma        — all 12 models with indexes and cascade rules
  seed.ts              — demo data: org, user, queues, 15 jobs, 1 scheduled job

/src/
  api/                 — Express app (routes, controllers, middleware)
    app.ts             — app factory (exported for tests)
    server.ts          — server entrypoint (binds port)
    middleware/        — auth, RBAC, error handling
    routes/            — thin route handlers, call shared services

  worker/
    index.ts           — worker process: register, poll, claim, execute, heartbeat

  scheduler/
    index.ts           — scheduler process: cron materializer + reaper

  shared/
    prisma.ts          — singleton PrismaClient
    redis.ts           — singleton ioredis + distributed lock helpers
    logger.ts          — winston structured logger
    services/          — all business logic (claim, execution, retry, reaper, etc.)
    handlers/          — job type handler registry (send-email, generate-report, flaky-job)

/dashboard/            — React + Vite + Tailwind dashboard
/tests/
  unit/                — zero-dependency unit tests
  integration/         — concurrent claim test
  api/                 — supertest API tests
/docs/                 — architecture, ER diagram, design decisions, API reference
```

---

## Demo Walkthrough

1. **Create a job:** `POST /api/jobs` with `type: "send-email"` → appears as QUEUED
2. **Watch it complete:** Within 2–3s the worker claims and completes it → dashboard shows COMPLETED
3. **Trigger a retry path:** Create a job with `type: "flaky-job"` and `payload.failProbability: 1.0`
   → watch retries with increasing delay → job lands in DEAD_LETTER
4. **Retry from DLQ:** Click the ↺ Retry button in Dead Letters tab → job re-queues with reset retry count
5. **Test the reaper:** Start a worker, create jobs, then kill the worker (`Ctrl+C`) mid-execution
   → within ~30s the scheduler reaper releases the stuck jobs back to QUEUED

---

## API Base URL

`http://localhost:4000/api`

See [api.md](./api.md) for the full endpoint reference.
