import { createApp } from './app';
import { logger } from '../shared/lib/logger';
import { prisma } from '../shared/lib/prisma';
import { redis } from '../shared/lib/redis';

process.env.SERVICE_NAME = 'api';

const PORT = parseInt(process.env.PORT ?? '4000', 10);

const app = createApp();

const server = app.listen(PORT, () => {
  logger.info('API server started', { port: PORT, env: process.env.NODE_ENV });
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info('API server shutting down', { signal });
  server.close(async () => {
    await prisma.$disconnect();
    redis.disconnect();
    logger.info('API server offline');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
