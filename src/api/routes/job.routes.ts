import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../shared/lib/prisma';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { retryJobFromDlq } from '../../shared/services/jobExecution.service';

const router = Router();
router.use(requireAuth);

// ── POST /api/jobs ────────────────────────────────────────────────────────────

const CreateJobSchema = z.object({
  queueId: z.string().min(1),
  type: z.string().min(1).max(100),
  payload: z.record(z.unknown()),
  priority: z.number().int().default(0),
  idempotencyKey: z.string().max(255).optional(),
  runAt: z.string().datetime().optional(),
  maxRetries: z.number().int().min(0).max(100).optional(),
  retryPolicyId: z.string().optional(),
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = CreateJobSchema.parse(req.body);

    // Verify queue belongs to user's org
    const queue = await prisma.queue.findFirst({
      where: {
        id: body.queueId,
        deletedAt: null,
        project: { organizationId: req.auth!.organizationId },
      },
    });
    if (!queue) throw new AppError(404, 'NOT_FOUND', 'Queue not found');

    // Idempotency check: if idempotencyKey provided, look for existing job
    if (body.idempotencyKey) {
      const existing = await prisma.job.findUnique({
        where: {
          queueId_idempotencyKey: {
            queueId: body.queueId,
            idempotencyKey: body.idempotencyKey,
          },
        },
      });

      if (existing) {
        // Return existing job with idempotent: true — safe to retry from client
        return res.status(200).json({ ...existing, idempotent: true });
      }
    }

    const runAt = body.runAt ? new Date(body.runAt) : new Date();
    const status = runAt > new Date() ? 'SCHEDULED' : 'QUEUED';

    const job = await prisma.job.create({
      data: {
        queueId: body.queueId,
        type: body.type,
        payload: body.payload as object,
        priority: body.priority,
        idempotencyKey: body.idempotencyKey ?? null,
        runAt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: status as any,
        maxRetries: body.maxRetries ?? queue.concurrencyLimit,
        retryPolicyId: body.retryPolicyId ?? null,
      },
    });

    return res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/jobs ─────────────────────────────────────────────────────────────

const ListJobsSchema = z.object({
  queueId: z.string().optional(),
  status: z
    .enum(['QUEUED', 'SCHEDULED', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER'])
    .optional(),
  type: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = ListJobsSchema.parse(req.query);

    const where: any = {
      queue: {
        project: { organizationId: req.auth!.organizationId },
        deletedAt: null,
      },
    };

    if (query.queueId) where.queueId = query.queueId;
    if (query.status) where.status = query.status;
    if (query.type) where.type = query.type;

    const skip = (query.page - 1) * query.pageSize;
    const take = query.pageSize;

    const [jobs, total] = await prisma.$transaction([
      prisma.job.findMany({
        where,
        skip,
        take,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        include: {
          queue: { select: { id: true, name: true } },
          retryPolicy: true,
        },
      }),
      prisma.job.count({ where }),
    ]);

    const totalPages = Math.ceil(total / query.pageSize);

    res.json({
      data: jobs,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/jobs/:id ─────────────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await prisma.job.findFirst({
      where: {
        id: req.params.id,
        queue: { project: { organizationId: req.auth!.organizationId } },
      },
      include: {
        executions: {
          orderBy: { attemptNumber: 'asc' },
        },
        logs: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        deadLetter: true,
        retryPolicy: true,
        queue: { select: { id: true, name: true } },
      },
    });

    if (!job) throw new AppError(404, 'NOT_FOUND', 'Job not found');

    res.json(job);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/jobs/:id/retry ──────────────────────────────────────────────────

router.post('/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await prisma.job.findFirst({
      where: {
        id: req.params.id,
        queue: { project: { organizationId: req.auth!.organizationId } },
      },
    });

    if (!job) throw new AppError(404, 'NOT_FOUND', 'Job not found');

    if (job.status !== 'FAILED' && job.status !== 'DEAD_LETTER') {
      throw new AppError(
        409,
        'INVALID_STATUS',
        `Job cannot be retried from status: ${job.status}. Only FAILED and DEAD_LETTER jobs can be retried.`,
      );
    }

    const retried = await retryJobFromDlq(job.id);
    res.json(retried);
  } catch (err) {
    next(err);
  }
});

export default router;
