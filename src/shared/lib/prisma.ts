import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

// Singleton PrismaClient — prevents exhausting the connection pool in hot-reload dev
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Forward Prisma events to winston
if (process.env.LOG_LEVEL === 'debug') {
  (prisma as any).$on('query', (e: any) => {
    logger.debug('Prisma query', { query: e.query, duration: e.duration });
  });
}

(prisma as any).$on('error', (e: any) => {
  logger.error('Prisma error', { message: e.message, target: e.target });
});
