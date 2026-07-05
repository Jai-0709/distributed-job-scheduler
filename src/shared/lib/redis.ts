import Redis from 'ioredis';
import { logger } from './logger';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Singleton ioredis client
let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    _redis.on('connect', () => logger.info('Redis connected'));
    _redis.on('error', (err) => logger.error('Redis error', { error: err.message }));
    _redis.on('close', () => logger.warn('Redis connection closed'));
  }
  return _redis;
}

export const redis = getRedis();

// ─── Distributed Lock Helpers ─────────────────────────────────────────────────
// Uses Redis SET NX PX pattern: only the holder of the token can release the lock.
// This prevents a crashed process from holding a lock forever (PX = TTL in ms).

const LOCK_TTL_MS = 5000; // 5 seconds

export async function acquireLock(key: string, token: string, ttlMs = LOCK_TTL_MS): Promise<boolean> {
  // ioredis v5: SET key value NX PX milliseconds
  // The overload accepts (key, value, 'NX', 'PX', milliseconds)
  const result = await (redis as any).set(`lock:${key}`, token, 'NX', 'PX', ttlMs);
  return result === 'OK';
}

export async function releaseLock(key: string, token: string): Promise<boolean> {
  // Lua script ensures atomic check-and-delete: only release if we still hold the token.
  // Without this, a slow process could release a lock that a different process acquired
  // after the original TTL expired.
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  const result = await redis.eval(script, 1, `lock:${key}`, token);
  return result === 1;
}
