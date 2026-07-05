import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../shared/lib/prisma';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { AppError } from '../middleware/errorHandler';
import { getQueueStats, pauseQueue, resumeQueue } from '../../shared/services/queue.service';

const router = Router();
router.use(requireAuth);

// ── POST /api/queues ──────────────────────────────────────────────────────────

const CreateQueueSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(100),
  concurrencyLimit: z.number().int().min(1).max(1000).default(10),
  rateLimitPerSec: z.number().int().min(1).optional(),
  defaultRetryPolicyId: z.string().optional(),
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = CreateQueueSchema.parse(req.body);

    // Verify project belongs to the user's org
    const project = await prisma.project.findFirst({
      where: {
        id: body.projectId,
        organizationId: req.auth!.organizationId,
        deletedAt: null,
      },
    });
    if (!project) throw new AppError(404, 'NOT_FOUND', 'Project not found');

    const queue = await prisma.queue.create({
      data: {
        name: body.name,
        concurrencyLimit: body.concurrencyLimit,
        rateLimitPerSec: body.rateLimitPerSec ?? null,
        defaultRetryPolicyId: body.defaultRetryPolicyId ?? null,
        projectId: body.projectId,
      },
    });

    res.status(201).json(queue);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/queues?projectId= ────────────────────────────────────────────────

const ListQueuesSchema = z.object({
  projectId: z.string().optional(),
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = ListQueuesSchema.parse(req.query);

    const queues = await prisma.queue.findMany({
      where: {
        deletedAt: null,
        project: {
          organizationId: req.auth!.organizationId,
          deletedAt: null,
        },
        ...(query.projectId ? { projectId: query.projectId } : {}),
      },
      include: {
        defaultRetryPolicy: true,
        project: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ data: queues });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/queues/:id/stats ─────────────────────────────────────────────────

router.get('/:id/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Verify queue belongs to user's org
    const queue = await prisma.queue.findFirst({
      where: {
        id: req.params.id,
        deletedAt: null,
        project: { organizationId: req.auth!.organizationId },
      },
    });
    if (!queue) throw new AppError(404, 'NOT_FOUND', 'Queue not found');

    const stats = await getQueueStats(req.params.id);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/queues/:id/pause (ADMIN only) ──────────────────────────────────

router.patch('/:id/pause', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const queue = await prisma.queue.findFirst({
      where: {
        id: req.params.id,
        deletedAt: null,
        project: { organizationId: req.auth!.organizationId },
      },
    });
    if (!queue) throw new AppError(404, 'NOT_FOUND', 'Queue not found');

    await pauseQueue(req.params.id);
    res.json({ success: true, message: 'Queue paused' });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/queues/:id/resume (ADMIN only) ─────────────────────────────────

router.patch('/:id/resume', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const queue = await prisma.queue.findFirst({
      where: {
        id: req.params.id,
        deletedAt: null,
        project: { organizationId: req.auth!.organizationId },
      },
    });
    if (!queue) throw new AppError(404, 'NOT_FOUND', 'Queue not found');

    await resumeQueue(req.params.id);
    res.json({ success: true, message: 'Queue resumed' });
  } catch (err) {
    next(err);
  }
});

export default router;
