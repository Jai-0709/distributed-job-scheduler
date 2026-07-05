# API Reference

Base URL: `http://localhost:4000/api`

All protected routes require: `Authorization: Bearer <token>`

Error shape (all errors): `{ "error": { "code": string, "message": string, "details"?: any } }`

---

## Authentication

### POST /api/auth/register

Creates a new organization and its first admin user.

**Body:**
```json
{
  "organizationName": "Acme Corp",
  "name": "Jane Doe",
  "email": "jane@acme.com",
  "password": "securepassword123"
}
```

**Response 201:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "user": { "id": "clxyz", "email": "jane@acme.com", "name": "Jane Doe", "role": "ADMIN" },
  "organization": { "id": "clyyz", "name": "Acme Corp" }
}
```

---

### POST /api/auth/login

**Body:**
```json
{ "email": "admin@demo.com", "password": "password123" }
```

**Response 200:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "user": { "id": "...", "email": "admin@demo.com", "name": "Demo Admin", "role": "ADMIN" },
  "organization": { "id": "...", "name": "Demo Organization" }
}
```

**Errors:** `401 INVALID_CREDENTIALS`

---

## Projects

### GET /api/projects

Returns all non-deleted projects in the user's organization.

**Response 200:**
```json
{ "data": [ { "id": "...", "name": "Demo Project", "description": "...", "organizationId": "...", "createdAt": "..." } ] }
```

---

### POST /api/projects

**Body:**
```json
{ "name": "My Project", "description": "Optional description" }
```

**Response 201:** Project object.
**Errors:** `409` on duplicate `(organizationId, name)`.

---

### GET /api/projects/:id

Returns project with all its queues (including `defaultRetryPolicy`).

**Response 200:**
```json
{
  "id": "...",
  "name": "Demo Project",
  "queues": [
    { "id": "...", "name": "default", "isPaused": false, "concurrencyLimit": 5, "defaultRetryPolicy": { ... } }
  ]
}
```

---

### DELETE /api/projects/:id

Soft-deletes the project (sets `deletedAt`). **ADMIN only.**

**Response:** `204 No Content`
**Errors:** `403 FORBIDDEN` if MEMBER. `404` if not found.

---

## Queues

### POST /api/queues

**Body:**
```json
{
  "projectId": "...",
  "name": "email",
  "concurrencyLimit": 3,
  "rateLimitPerSec": 10,
  "defaultRetryPolicyId": "..."
}
```

**Response 201:** Queue object.

---

### GET /api/queues

Optional query: `?projectId=<id>`

**Response 200:**
```json
{ "data": [ { "id": "...", "name": "default", "isPaused": false, "project": { "id": "...", "name": "Demo Project" } } ] }
```

---

### GET /api/queues/:id/stats

**Response 200:**
```json
{
  "queueId": "...",
  "queueName": "default",
  "isPaused": false,
  "statusCounts": { "QUEUED": 5, "RUNNING": 2, "COMPLETED": 47 },
  "total": 54,
  "oldestQueuedJobAge": 3200
}
```

`oldestQueuedJobAge` is in milliseconds — a large value signals backlog build-up.

---

### PATCH /api/queues/:id/pause

**ADMIN only.** Pauses the queue (workers skip it during polling). Uses Redis distributed lock.

**Response 200:**
```json
{ "success": true, "message": "Queue paused" }
```

---

### PATCH /api/queues/:id/resume

**ADMIN only.** Resumes a paused queue.

**Response 200:**
```json
{ "success": true, "message": "Queue resumed" }
```

---

## Jobs

### POST /api/jobs

Create a job. Omit `runAt` for immediate execution; supply a future ISO timestamp for delayed/scheduled jobs.

**Body:**
```json
{
  "queueId": "...",
  "type": "send-email",
  "payload": { "to": "user@example.com", "subject": "Hello" },
  "priority": 5,
  "idempotencyKey": "welcome-email-user123",
  "runAt": "2025-01-01T12:00:00Z",
  "maxRetries": 3,
  "retryPolicyId": "..."
}
```

**Response 201 (new job):**
```json
{ "id": "...", "type": "send-email", "status": "QUEUED", "priority": 5, ... }
```

**Response 200 (duplicate idempotencyKey):**
```json
{ "id": "...", "status": "QUEUED", ..., "idempotent": true }
```

**Errors:** `400` validation, `404` queue not found.

---

### GET /api/jobs

Paginated list with optional filters.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `queueId` | string | Filter by queue |
| `status` | enum | QUEUED\|SCHEDULED\|CLAIMED\|RUNNING\|COMPLETED\|FAILED\|DEAD_LETTER |
| `type` | string | Filter by job type |
| `page` | int (default 1) | Page number |
| `pageSize` | int (default 20, max 100) | Items per page |

**Response 200:**
```json
{
  "data": [ { "id": "...", "type": "send-email", "status": "COMPLETED", "retryCount": 0, "queue": { "name": "default" } } ],
  "pagination": { "page": 1, "pageSize": 20, "total": 47, "totalPages": 3 }
}
```

**Errors:** `400` on invalid status enum or out-of-range page/pageSize.

---

### GET /api/jobs/:id

Returns full job detail with execution history, recent logs (last 50), and DLQ record if present.

**Response 200:**
```json
{
  "id": "...",
  "type": "flaky-job",
  "status": "DEAD_LETTER",
  "retryCount": 3,
  "maxRetries": 3,
  "lastFailureReason": "Flaky job task-003 failed on attempt 3 (simulated failure)",
  "executions": [
    { "id": "...", "attemptNumber": 1, "status": "FAILED", "durationMs": 142, "errorMessage": "..." },
    { "id": "...", "attemptNumber": 2, "status": "FAILED", "durationMs": 98, "errorMessage": "..." },
    { "id": "...", "attemptNumber": 3, "status": "FAILED", "durationMs": 103, "errorMessage": "..." }
  ],
  "logs": [ { "level": "ERROR", "message": "Job exhausted all retries...", "createdAt": "..." } ],
  "deadLetter": { "id": "...", "reason": "...", "payloadSnapshot": { ... }, "failedAt": "..." }
}
```

**Errors:** `404` if not found.

---

### POST /api/jobs/:id/retry

Re-queues a FAILED or DEAD_LETTER job. Resets `retryCount` to 0. Marks `retriedFromDlqAt` on the DLQ record if applicable.

**Response 200:** Updated job object (status: QUEUED).
**Errors:** `409 INVALID_STATUS` if job is not in FAILED or DEAD_LETTER status. `404` if not found.

---

## Workers

### GET /api/workers

Returns all registered workers with their most recent heartbeat.

**Response 200:**
```json
{
  "data": [
    {
      "id": "...",
      "hostname": "my-machine",
      "pid": 12345,
      "status": "ONLINE",
      "concurrency": 5,
      "currentLoad": 2,
      "lastSeenAt": "2025-01-01T12:00:00Z",
      "heartbeats": [ { "activeJobs": 2, "memoryMb": 48.3, "timestamp": "..." } ]
    }
  ]
}
```

---

### POST /api/workers/heartbeat

Internal endpoint called by worker processes to update their liveness.

**Body:**
```json
{ "workerId": "...", "activeJobs": 2, "cpuLoad": 0.3, "memoryMb": 48.3 }
```

**Response 200:** `{ "success": true }`

---

## Dead Letter Queue

### GET /api/dlq

Paginated dead letter entries.

**Query params:**

| Param | Type | Description |
|---|---|---|
| `queueId` | string | Filter by queue |
| `page` | int | Page number |
| `pageSize` | int | Items per page (max 100) |

**Response 200:**
```json
{
  "data": [
    {
      "id": "...",
      "jobId": "...",
      "queueId": "...",
      "reason": "Flaky job task-003 failed (simulated failure)",
      "payloadSnapshot": { "taskId": "task-003", "failProbability": 1.0 },
      "failedAt": "2025-01-01T12:00:00Z",
      "retriedFromDlqAt": null,
      "job": { "id": "...", "type": "flaky-job", "retryCount": 3, "maxRetries": 3 }
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 3, "totalPages": 1 }
}
```

---

## Common HTTP Status Codes

| Code | Meaning |
|---|---|
| 200 | OK |
| 201 | Created |
| 204 | No Content (DELETE) |
| 400 | Validation error (Zod) |
| 401 | Missing or invalid JWT |
| 403 | Forbidden (wrong role) |
| 404 | Record not found |
| 409 | Conflict (duplicate key, invalid status transition) |
| 429 | Rate limited |
| 500 | Internal server error |
