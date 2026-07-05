/**
 * Retry delay calculation — pure function, zero external dependencies.
 * No Prisma, no Redis, no I/O — this is intentionally dependency-free so it
 * can be unit-tested in CI without any infrastructure.
 *
 * Strategies:
 *   FIXED:       delay = baseDelayMs
 *   LINEAR:      delay = baseDelayMs × attemptNumber × multiplier
 *   EXPONENTIAL: delay = baseDelayMs × multiplier^(attemptNumber - 1)
 *
 * After computing the base delay, applies ±20% random jitter (thundering-herd
 * prevention) and clamps the result to maxDelayMs.
 *
 * The jitter bounds ensure that a batch of workers retrying the same resource
 * after a failure won't all hit it at the identical millisecond.
 */

export type RetryStrategy = 'FIXED' | 'LINEAR' | 'EXPONENTIAL';

export interface RetryDelayParams {
  strategy: RetryStrategy;
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  attemptNumber: number; // 1-indexed (first retry = attempt 1)
}

/**
 * Calculate the delay before the next retry attempt.
 *
 * @param params - retry policy parameters
 * @returns delay in milliseconds (clamped to maxDelayMs, with ±20% jitter)
 */
export function calculateRetryDelay(params: RetryDelayParams): number {
  const { strategy, baseDelayMs, maxDelayMs, multiplier, attemptNumber } = params;

  if (attemptNumber < 1) {
    throw new Error(`attemptNumber must be >= 1, got ${attemptNumber}`);
  }

  let baseDelay: number;

  switch (strategy) {
    case 'FIXED':
      baseDelay = baseDelayMs;
      break;

    case 'LINEAR':
      baseDelay = baseDelayMs * attemptNumber * multiplier;
      break;

    case 'EXPONENTIAL':
      // delay = baseDelayMs × multiplier^(attemptNumber - 1)
      // attempt 1 → baseDelayMs × 1 = baseDelayMs
      // attempt 2 → baseDelayMs × multiplier
      // attempt 3 → baseDelayMs × multiplier²
      baseDelay = baseDelayMs * Math.pow(multiplier, attemptNumber - 1);
      break;

    default:
      throw new Error(`Unknown retry strategy: ${strategy as string}`);
  }

  // Apply ±20% jitter: random in range [0.8, 1.2]
  const jitterFactor = 0.8 + Math.random() * 0.4;
  const jitteredDelay = baseDelay * jitterFactor;

  // Clamp to maxDelayMs
  return Math.min(jitteredDelay, maxDelayMs);
}

/**
 * Determine whether a job should be retried or moved to DEAD_LETTER.
 *
 * @param retryCount - current retry count (0-indexed, how many times already tried)
 * @param maxRetries - maximum allowed retries
 * @returns true if the job should be retried
 */
export function shouldRetry(retryCount: number, maxRetries: number): boolean {
  return retryCount < maxRetries;
}
