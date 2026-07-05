# Architecture

## System Diagram

```mermaid
graph TB
    subgraph Client
        UI[React Dashboard<br/>localhost:5173]
    end

    subgraph API["API Process (Express :4000)"]
        AR[Auth Routes]
        JR[Job Routes]
        QR[Queue Routes]
        WR[Worker Routes]
        DLQ[DLQ Routes]
        MW[Auth + Rate Limit<br/>+ Error Middleware]
    end

    subgraph Worker["Worker Process(es)"]
        WP[Poll Loop<br/>every 2s]
        HB[Heartbeat Loop<br/>every 10s]
        EX[Job Executor<br/>concurrent up to N]
        HR[Handler Registry<br/>send-email, generate-report, flaky-job]
    end

    subgraph Scheduler["Scheduler Process"]
        CM[Cron Materializer<br/>every 30s]
        RP[Stale-Claim Reaper<br/>every 15s]
    end

    subgraph Storage
        PG[(PostgreSQL 16<br/>12 tables)]
        RD[(Redis 7<br/>locks + pub/sub)]
    end

    UI -->|REST + JWT Bearer| API
    API -->|Prisma ORM| PG
    API -->|ioredis| RD

    Worker -->|FOR UPDATE SKIP LOCKED| PG
    Worker -->|heartbeat writes| PG
    Worker -->|ioredis| RD

    Scheduler -->|find due ScheduledJobs| PG
    Scheduler -->|materialize Job rows| PG
    Scheduler -->|find stale workers| PG
    Scheduler -->|release stuck jobs| PG

    WP --> EX
    EX --> HR
    HB -->|lastSeenAt + WorkerHeartbeat| PG
```

---

## Process Separation Rationale

### Why three separate processes?

**Independent scaling.** Workers are the compute-intensive component — each additional worker process adds linear throughput because the `FOR UPDATE SKIP LOCKED` claim query is safe under concurrent contention. You can run ten worker instances with no coordination overhead beyond what Postgres provides. The API process is stateless and can sit behind a load balancer. The scheduler is a singleton for simplicity (running two would double-materialize cron jobs without a leader election mechanism — see Design Decisions for the cut scope note).

**Failure isolation.** A crashing worker doesn't affect the API or the scheduler. In-flight jobs are recovered by the reaper within 30 seconds. A crashing scheduler doesn't lose in-flight executions because the scheduler only *creates* Job rows — it never runs handlers. The API can continue serving read and create requests even if both other processes are down.

**Operational clarity.** Each process has a single responsibility and a clear shutdown contract:
- The API drains HTTP connections on SIGTERM.
- The worker marks itself DRAINING, waits for in-flight jobs, then goes OFFLINE.
- The scheduler just stops its intervals — no in-flight state to drain.

---

## Data Flow: Job Lifecycle

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant DB as PostgreSQL
    participant W as Worker
    participant S as Scheduler

    C->>A: POST /api/jobs {type, payload}
    A->>DB: INSERT Job (status=QUEUED)
    A-->>C: 201 { id, status: QUEUED }

    W->>DB: SELECT FOR UPDATE SKIP LOCKED (poll)
    DB-->>W: [Job row locked]
    W->>DB: UPDATE status=CLAIMED, claimedByWorkerId
    W->>DB: INSERT JobExecution (status=RUNNING)
    W->>DB: UPDATE Job status=RUNNING
    W->>W: execute handler(job)

    alt Success
        W->>DB: UPDATE JobExecution status=SUCCEEDED
        W->>DB: UPDATE Job status=COMPLETED
    else Failure, retries remaining
        W->>DB: UPDATE JobExecution status=FAILED
        W->>DB: UPDATE Job status=QUEUED, runAt=now+delay
    else Failure, retries exhausted
        W->>DB: UPDATE Job status=DEAD_LETTER
        W->>DB: INSERT DeadLetterQueue (payloadSnapshot)
    end

    S->>DB: find ScheduledJob where nextRunAt <= now
    S->>DB: INSERT Job (QUEUED), UPDATE nextRunAt
```

---

## Reaper Flow

```mermaid
sequenceDiagram
    participant S as Scheduler (Reaper)
    participant DB as PostgreSQL

    loop every 15s
        S->>DB: find Workers where lastSeenAt < now-30s AND status IN [ONLINE, DRAINING]
        DB-->>S: [stale workers]
        S->>DB: UPDATE Worker SET status=OFFLINE (transaction)
        S->>DB: find Jobs where claimedByWorkerId IN [stale] AND status IN [CLAIMED, RUNNING]
        S->>DB: UPDATE Job SET status=QUEUED, claimedByWorkerId=null (same transaction)
        S->>DB: INSERT JobLog "released by reaper"
    end
```

---

## Horizontal Scaling Notes

| Component | How to scale |
|---|---|
| Worker | Run N worker processes. The claim query's `SKIP LOCKED` means no coordination is needed — each worker claims its own slice. |
| API | Stateless — put behind any load balancer (nginx, ALB). Each instance reads from the same Postgres. |
| Scheduler | Run as a singleton. Two schedulers would double-materialize cron jobs. A production-grade solution would use a Postgres advisory lock or Redis leader election. |
| Postgres | At current scale: one primary is sufficient. At 10x job volume: add read replicas for the API's SELECT-heavy queries; the write path (claim, heartbeat, execution update) stays on the primary. At 100x: consider partitioning the Job table by queueId. |
| Redis | Used only for distributed locks (SET NX PX). At current scale one Redis instance is sufficient. Sentinel or Cluster for HA if needed. |
