import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../shared/lib/prisma';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { AppError } from '../middleware/errorHandler';

const router = Router();
router.use(requireAuth);

// ── GET /api/projects ─────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projects = await prisma.project.findMany({
      where: {
        organizationId: req.auth!.organizationId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: projects });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects ────────────────────────────────────────────────────────

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = CreateProjectSchema.parse(req.body);

    const project = await prisma.project.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        organizationId: req.auth!.organizationId,
      },
    });

    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:id ─────────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await prisma.project.findFirst({
      where: {
        id: req.params.id,
        organizationId: req.auth!.organizationId,
        deletedAt: null,
      },
      include: {
        queues: {
          where: { deletedAt: null },
          include: { defaultRetryPolicy: true },
        },
      },
    });

    if (!project) {
      throw new AppError(404, 'NOT_FOUND', 'Project not found');
    }

    res.json(project);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/projects/:id (soft delete, ADMIN only) ────────────────────────

router.delete('/:id', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await prisma.project.findFirst({
      where: {
        id: req.params.id,
        organizationId: req.auth!.organizationId,
        deletedAt: null,
      },
    });

    if (!project) {
      throw new AppError(404, 'NOT_FOUND', 'Project not found');
    }

    await prisma.project.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() },
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
