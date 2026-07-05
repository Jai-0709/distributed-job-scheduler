# ER Diagram

```mermaid
erDiagram
    Organization {
        string id PK
        string name
        datetime createdAt
        datetime updatedAt
        datetime deletedAt "nullable, soft delete"
    }

    User {
        string id PK
        string email "unique"
        string passwordHash
        string name
        enum role "ADMIN | MEMBER"
        string organizationId FK
        datetime createdAt
        datetime updatedAt
        datetime deletedAt "nullable"
    }

    Project {
        string id PK
        string name
        string description "nullable"
        string organizationId FK
        datetime createdAt
        datetime updatedAt
        datetime deletedAt "nullable"
    }

    RetryPolicy {
        string id PK
        string name
        enum strategy "FIXED | LINEAR | EXPONENTIAL"
        int maxRetries
        int baseDelayMs
        int maxDelayMs
        float multiplier
        datetime createdAt
        datetime updatedAt
    }

    Queue {
        string id PK
        string name
        int concurrencyLimit
        bool isPaused
        int rateLimitPerSec "nullable"
        string projectId FK
        string defaultRetryPolicyId FK "nullable"
        datetime createdAt
        datetime updatedAt
        datetime deletedAt "nullable"
    }

    Job {
        string id PK
        string type
        json payload
        enum status "QUEUED|SCHEDULED|CLAIMED|RUNNING|COMPLETED|FAILED|DEAD_LETTER"
        int priority
        string idempotencyKey "nullable, unique per queue"
        datetime runAt
        int retryCount
        int maxRetries
        string lastFailureReason "nullable"
        string claimedByWorkerId "nullable"
        datetime claimedAt "nullable"
        datetime startedAt "nullable"
        datetime completedAt "nullable"
        string queueId FK
        string retryPolicyId FK "nullable"
        datetime createdAt
        datetime updatedAt
    }

    JobExecution {
        string id PK
        int attemptNumber
        enum status "RUNNING | SUCCEEDED | FAILED"
        datetime startedAt
        datetime finishedAt "nullable"
        int durationMs "nullable"
        string errorMessage "nullable"
        string jobId FK
        string workerId FK "nullable"
        datetime createdAt
        datetime updatedAt
    }

    Worker {
        string id PK
        string hostname
        int pid
        enum status "ONLINE | OFFLINE | DRAINING"
        int concurrency
        int currentLoad
        datetime registeredAt
        datetime lastSeenAt
    }

    WorkerHeartbeat {
        string id PK
        string workerId FK
        datetime timestamp
        int activeJobs
        float cpuLoad "nullable"
        float memoryMb "nullable"
    }

    JobLog {
        string id PK
        string jobId FK
        string executionId FK "nullable"
        enum level "INFO | WARN | ERROR"
        string message
        json meta "nullable"
        datetime createdAt
    }

    ScheduledJob {
        string id PK
        string name
        string cronExpression
        string jobType
        json payloadTemplate
        bool isActive
        datetime lastRunAt "nullable"
        datetime nextRunAt "nullable"
        string queueId FK
        datetime createdAt
        datetime updatedAt
    }

    DeadLetterQueue {
        string id PK
        string jobId FK "unique"
        string queueId
        json payloadSnapshot "immutable copy"
        string reason
        datetime failedAt
        datetime retriedFromDlqAt "nullable"
        datetime createdAt
    }

    Organization ||--o{ User : "has many (Restrict)"
    Organization ||--o{ Project : "has many (Restrict)"
    Project ||--o{ Queue : "has many (Restrict)"
    Queue ||--o{ Job : "has many (Restrict)"
    Queue }o--o| RetryPolicy : "default policy (SetNull)"
    Job }o--o| RetryPolicy : "override policy (SetNull)"
    Job ||--o{ JobExecution : "has many (Cascade)"
    Job ||--o{ JobLog : "has many (Cascade)"
    Job ||--o| DeadLetterQueue : "has one (Cascade)"
    JobExecution }o--o| Worker : "executed by (SetNull)"
    JobExecution ||--o{ JobLog : "has many (SetNull)"
    Worker ||--o{ WorkerHeartbeat : "has many (Cascade)"
    Queue ||--o{ ScheduledJob : "has many (Cascade)"
```

---

## Key Index Justifications

| Index | Table | Purpose |
|---|---|---|
| `(queueId, status, runAt)` | Job | Claim query filter: `WHERE queueId = $1 AND status = 'QUEUED' AND runAt <= now()` — composite index covers all three predicates in one scan |
| `(queueId, idempotencyKey)` | Job | Unique constraint for duplicate-safe submissions — O(1) lookup |
| `(workerId, timestamp)` | WorkerHeartbeat | Reaper and dashboard queries filtering by worker over time |
| `(jobId, createdAt)` | JobLog | Fetch recent logs for a job, ordered chronologically |
| `(isActive, nextRunAt)` | ScheduledJob | Scheduler polls this exact filter every 30s |
| `queueId` | DeadLetterQueue | DLQ listing filtered by queue |

## Cascade Rules Summary

| Relationship | Rule | Reason |
|---|---|---|
| Job → JobExecution | Cascade | Execution records are meaningless without their job |
| Job → JobLog | Cascade | Log lines are meaningless without their job |
| Job → DeadLetterQueue | Cascade | DLQ record is meaningless without its job |
| Worker → WorkerHeartbeat | Cascade | Heartbeat log is meaningless without the worker |
| Queue → ScheduledJob | Cascade | Cron templates exist in the context of their queue |
| Org → User | Restrict | Cannot silently delete an org with active users |
| Org → Project | Restrict | Cannot silently delete an org with active projects |
| Project → Queue | Restrict | Cannot silently delete a project with active queues |
| Queue → Job | Restrict | Cannot silently delete a queue with jobs in it |
