import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../shared/lib/prisma';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// ── GET /api/workers ──────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workers = await prisma.worker.findMany({
      orderBy: { registeredAt: 'desc' },
      include: {
        heartbeats: {
          orderBy: { timestamp: 'desc' },
          take: 1, // most recent heartbeat only
        },
      },
    });

    res.json({ data: workers });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/workers/heartbeat (internal, called by worker processes) ─────────

router.post('/heartbeat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { workerId, activeJobs, cpuLoad, memoryMb } = req.body;

    if (!workerId) {
      res.status(400).json({ error: { code: 'MISSING_FIELD', message: 'workerId required' } });
      return;
    }

    await prisma.$transaction([
      prisma.worker.update({
        where: { id: workerId },
        data: {
          lastSeenAt: new Date(),
          currentLoad: activeJobs ?? 0,
        },
      }),
      prisma.workerHeartbeat.create({
        data: {
          workerId,
          activeJobs: activeJobs ?? 0,
          cpuLoad: cpuLoad ?? null,
          memoryMb: memoryMb ?? null,
          timestamp: new Date(),
        },
      }),
    ]);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
