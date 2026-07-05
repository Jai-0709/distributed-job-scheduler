import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../shared/lib/prisma';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── GET /api/dlq?queueId= ─────────────────────────────────────────────────────

const ListDlqSchema = z.object({
  queueId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = ListDlqSchema.parse(req.query);

    const where: any = {
      job: {
        queue: {
          project: { organizationId: req.auth!.organizationId },
          deletedAt: null,
        },
      },
    };

    if (query.queueId) where.queueId = query.queueId;

    const skip = (query.page - 1) * query.pageSize;

    const [dlqEntries, total] = await prisma.$transaction([
      prisma.deadLetterQueue.findMany({
        where,
        skip,
        take: query.pageSize,
        orderBy: { failedAt: 'desc' },
        include: {
          job: {
            select: {
              id: true,
              type: true,
              status: true,
              retryCount: true,
              maxRetries: true,
              lastFailureReason: true,
              createdAt: true,
              queue: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.deadLetterQueue.count({ where }),
    ]);

    res.json({
      data: dlqEntries,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
