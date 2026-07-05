# Architecture & Engineering Design Decisions

This document details the architectural decisions, trade-offs, database indexing strategies, and failure-recovery mechanisms implemented in Relay.

---

## 1. Concurrency Control: `SELECT FOR UPDATE SKIP LOCKED`

To claim jobs, Relay executes the following query inside a serializable read-committed database transaction:

```sql
SELECT id FROM "Job"
WHERE "queueId" = $1
  AND status = 'QUEUED'
  AND "runAt" <= now()
ORDER BY priority DESC, "createdAt" ASC
LIMIT $2
FOR UPDATE SKIP LOCKED;
```

### Why not standard transactional locking?
Using `FOR UPDATE` alone causes transaction blockings (queuing) when multiple worker threads attempt to claim work simultaneously. Workers block waiting for locks to release, resulting in thread starvation and latency.

### Why `SKIP LOCKED`?
`SKIP LOCKED` instructs PostgreSQL to skip any rows currently locked by other transactions. 
- Result: Concurrency throughput is maintained. Workers process disjoint sets of jobs.
- Trade-off: Non-deterministic execution order under contention. A worker might process job B before job A if A was locked, despite A having a higher priority. In background task queues, this trade-off is acceptable.

---

## 2. Table Separation: `Job` vs. `JobExecution`

We maintain separate `Job` (state) and `JobExecution` (history/attempts) tables.

### Design Trade-offs
- Single Table (Anti-pattern): Overwriting attempts on a single row removes audit trails. Storing attempt arrays in JSON columns prevents indexing and SQL aggregations.
- Separated Tables (Relay): 
  - `Job` is optimized for write/read polling: it contains active columns (`status`, `runAt`) with composite indexes.
  - `JobExecution` is append-only, capturing execution time, worker ID, and stack traces.
  - Result: Maintains consistent write-amplification bounds on worker poll routes while preserving forensic histories.

---

## 3. Database Indexing Strategy

Relay indexes PostgreSQL tables for performance under write/read volume.

### Key Index: `Job_queueId_status_runAt_idx`
- Fields: `(queueId, status, runAt)`
- Rationale: The worker's job claim query searches on `queueId` and `status = 'QUEUED'`, and filters on `runAt <= now()`.
- Postgres Query Optimizer: This composite index enables an Index Range Scan instead of a Sequential Table Scan. Without this, query execution time grows linearly with database size ($O(N)$), degrading worker poll loops.

### Key Index: `Job_idempotencyKey_orgId_idx`
- Fields: `(idempotencyKey, organizationId)` on `Job`
- Rationale: Ensures validation of client idempotency checks within the scope of a tenant organization.

---

## 4. Reliability & Failover: Heartbeats & The Reaper

In a distributed environment, worker nodes can crash mid-job due to network outages, hardware failures, or out-of-memory errors.

### Heartbeat Mechanism
Workers report status to the database every 10 seconds, updating `lastSeenAt`.

### The Reaper Loop
A singleton cron job in the Scheduler process checks worker health every 15 seconds.
- Threshold: If a worker's `lastSeenAt` exceeds 30 seconds, it is marked `OFFLINE`.
- Atomic Cleanup: Within a single database transaction, the reaper updates the worker's state and resets all jobs stuck in `CLAIMED` or `RUNNING` under that worker back to `QUEUED`, rescheduling them for immediate retry.
- Safety: If a worker is reaped but recovers (e.g., GC pause ended), the worker's heartbeat will verify its status, see it has been forced `OFFLINE`, and terminate.

---

## 5. Retry Delay & Algorithmic Jitter

When a job fails, Relay reschedules it with a calculated backoff delay. To prevent thundering herd problems (where multiple failing jobs retry at the same millisecond, overloading downstream databases/services), Relay introduces random jitter.

### Delay Strategies
1. FIXED: Always delay by D milliseconds.
2. LINEAR: Delay by D * A, where A is the attempt count.
3. EXPONENTIAL: Delay by D * M^(A-1), where M is the multiplier.

### Jitter Formula
We apply a randomized variation of +/-20% to the base calculation:
$$\text{Delay}_{\text{jitter}} = \text{Delay}_{\text{base}} \times (1 + \text{random}(-0.2, 0.2))$$

This is a pure function under test (`tests/unit/retryPolicy.test.ts`), verifying backoff calculations.

---

## 6. Distributed Queue Locking

Pause/resume functions use a distributed locking pattern implemented via Redis.

- Mechanism: `SET queue:lock NX PX 5000` ensures atomic exclusivity.
- Lua CAS Release: Locks are released using a Lua script to verify token matching. This prevents a node from releasing a lock acquired by another node after a timeout.
```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
```

---

## 7. Explicit Scope Cuts

The following were explicitly deferred:
- WebSockets: Replaced with 5-second HTTP polling to avoid persistent socket connection leaks.
- Queue Sharding: Bypassed for simple partitioning/composite index strategy, capable of handling typical transactional volumes.
- DAG Workflows: Bypassed in favor of standard independent job queues.
