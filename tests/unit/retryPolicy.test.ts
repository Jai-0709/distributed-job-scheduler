/**
 * Unit tests for retry delay calculation.
 *
 * These tests have ZERO external dependencies — no DB, no Redis, no I/O.
 * They run instantly in CI without any infrastructure.
 *
 * Run with: npm test tests/unit
 */

export {}; // make this file a module

import {
  calculateRetryDelay,
  shouldRetry,
  RetryDelayParams,
} from '../../src/shared/services/retryPolicy.service';

// Helper: run the function many times and check bounds
function runMany(params: RetryDelayParams, iterations = 1000): number[] {
  return Array.from({ length: iterations }, () => calculateRetryDelay(params));
}

describe('calculateRetryDelay', () => {
  describe('FIXED strategy', () => {
    const base: RetryDelayParams = {
      strategy: 'FIXED',
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      multiplier: 1.0,
      attemptNumber: 1,
    };

    it('returns baseDelayMs (±20% jitter) on attempt 1', () => {
      const results = runMany(base);
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(800);   // 1000 * 0.8
        expect(r).toBeLessThanOrEqual(1200);     // 1000 * 1.2
      }
    });

    it('returns the same range on any attempt (delay does not scale)', () => {
      const attempt5 = runMany({ ...base, attemptNumber: 5 });
      for (const r of attempt5) {
        expect(r).toBeGreaterThanOrEqual(800);
        expect(r).toBeLessThanOrEqual(1200);
      }
    });

    it('is clamped to maxDelayMs when baseDelayMs > maxDelayMs', () => {
      const clamped = runMany({ ...base, baseDelayMs: 6000, maxDelayMs: 5000 });
      for (const r of clamped) {
        expect(r).toBeLessThanOrEqual(5000);
      }
    });
  });

  describe('LINEAR strategy', () => {
    const base: RetryDelayParams = {
      strategy: 'LINEAR',
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      multiplier: 1.5,
      attemptNumber: 1,
    };

    it('scales linearly: attempt N = baseDelayMs * N * multiplier (±20%)', () => {
      // attempt 1: 1000 * 1 * 1.5 = 1500
      const results1 = runMany({ ...base, attemptNumber: 1 });
      for (const r of results1) {
        expect(r).toBeGreaterThanOrEqual(1500 * 0.8);
        expect(r).toBeLessThanOrEqual(1500 * 1.2);
      }

      // attempt 3: 1000 * 3 * 1.5 = 4500
      const results3 = runMany({ ...base, attemptNumber: 3 });
      for (const r of results3) {
        expect(r).toBeGreaterThanOrEqual(4500 * 0.8);
        expect(r).toBeLessThanOrEqual(4500 * 1.2);
      }
    });

    it('delay at attempt 4 is roughly 4x delay at attempt 1 (proportional)', () => {
      const mean1 = average(runMany({ ...base, attemptNumber: 1 }));
      const mean4 = average(runMany({ ...base, attemptNumber: 4 }));
      // Allow 5% tolerance around the 4x ratio
      expect(mean4 / mean1).toBeGreaterThan(3.7);
      expect(mean4 / mean1).toBeLessThan(4.3);
    });
  });

  describe('EXPONENTIAL strategy', () => {
    const base: RetryDelayParams = {
      strategy: 'EXPONENTIAL',
      baseDelayMs: 1000,
      maxDelayMs: 60000,
      multiplier: 2.0,
      attemptNumber: 1,
    };

    it('attempt 1 yields baseDelayMs (±20%): 1000 * 2^0 = 1000', () => {
      const results = runMany({ ...base, attemptNumber: 1 });
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(800);
        expect(r).toBeLessThanOrEqual(1200);
      }
    });

    it('attempt 2 yields baseDelayMs * multiplier^1 (±20%): 2000', () => {
      const results = runMany({ ...base, attemptNumber: 2 });
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(2000 * 0.8);
        expect(r).toBeLessThanOrEqual(2000 * 1.2);
      }
    });

    it('attempt 3 yields 4000ms (±20%): 1000 * 2^2 = 4000', () => {
      const results = runMany({ ...base, attemptNumber: 3 });
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(4000 * 0.8);
        expect(r).toBeLessThanOrEqual(4000 * 1.2);
      }
    });

    it('attempt 4 yields 8000ms (±20%): 1000 * 2^3 = 8000', () => {
      const results = runMany({ ...base, attemptNumber: 4 });
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(8000 * 0.8);
        expect(r).toBeLessThanOrEqual(8000 * 1.2);
      }
    });

    it('grows exponentially (each attempt ~2x previous)', () => {
      const mean1 = average(runMany({ ...base, attemptNumber: 1 }));
      const mean2 = average(runMany({ ...base, attemptNumber: 2 }));
      const mean3 = average(runMany({ ...base, attemptNumber: 3 }));

      // ratio should be ~2x (within 10% tolerance due to jitter)
      expect(mean2 / mean1).toBeGreaterThan(1.8);
      expect(mean2 / mean1).toBeLessThan(2.2);
      expect(mean3 / mean2).toBeGreaterThan(1.8);
      expect(mean3 / mean2).toBeLessThan(2.2);
    });
  });

  describe('Max delay clamp', () => {
    it('clamps result to maxDelayMs for EXPONENTIAL that would exceed it', () => {
      const params: RetryDelayParams = {
        strategy: 'EXPONENTIAL',
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        multiplier: 2.0,
        attemptNumber: 10, // 1000 * 2^9 = 512000ms >> maxDelayMs
      };
      const results = runMany(params);
      for (const r of results) {
        expect(r).toBeLessThanOrEqual(5000);
      }
    });

    it('clamps result to maxDelayMs for LINEAR that would exceed it', () => {
      const params: RetryDelayParams = {
        strategy: 'LINEAR',
        baseDelayMs: 1000,
        maxDelayMs: 3000,
        multiplier: 10.0,
        attemptNumber: 5, // 1000 * 5 * 10 = 50000 >> maxDelayMs
      };
      const results = runMany(params);
      for (const r of results) {
        expect(r).toBeLessThanOrEqual(3000);
      }
    });

    it('never returns a negative delay', () => {
      const allStrategies: RetryStrategy[] = ['FIXED', 'LINEAR', 'EXPONENTIAL'];
      for (const strategy of allStrategies) {
        const results = runMany({
          strategy,
          baseDelayMs: 100,
          maxDelayMs: 1000,
          multiplier: 1.0,
          attemptNumber: 1,
        });
        for (const r of results) {
          expect(r).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe('Jitter', () => {
    it('produces a spread of values (not deterministic)', () => {
      const params: RetryDelayParams = {
        strategy: 'FIXED',
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        multiplier: 1.0,
        attemptNumber: 1,
      };
      const results = runMany(params, 100);
      const unique = new Set(results.map((r) => Math.floor(r)));
      // With ±20% jitter over 100 samples, we should see significant spread
      expect(unique.size).toBeGreaterThan(20);
    });

    it('jitter stays within ±20% of the base delay', () => {
      // FIXED: base = 1000ms, so all results must be in [800, 1200]
      const params: RetryDelayParams = {
        strategy: 'FIXED',
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        multiplier: 1.0,
        attemptNumber: 1,
      };
      const results = runMany(params, 500);
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(800);
        expect(r).toBeLessThanOrEqual(1200);
      }
    });
  });

  describe('Edge cases', () => {
    it('throws for attemptNumber < 1', () => {
      expect(() =>
        calculateRetryDelay({
          strategy: 'FIXED',
          baseDelayMs: 1000,
          maxDelayMs: 5000,
          multiplier: 1.0,
          attemptNumber: 0,
        }),
      ).toThrow();
    });

    it('throws for unknown strategy', () => {
      expect(() =>
        calculateRetryDelay({
          strategy: 'UNKNOWN' as any,
          baseDelayMs: 1000,
          maxDelayMs: 5000,
          multiplier: 1.0,
          attemptNumber: 1,
        }),
      ).toThrow();
    });
  });
});

type RetryStrategy = 'FIXED' | 'LINEAR' | 'EXPONENTIAL';

describe('shouldRetry', () => {
  it('returns true when retryCount < maxRetries', () => {
    expect(shouldRetry(0, 3)).toBe(true);
    expect(shouldRetry(1, 3)).toBe(true);
    expect(shouldRetry(2, 3)).toBe(true);
  });

  it('returns false when retryCount >= maxRetries', () => {
    expect(shouldRetry(3, 3)).toBe(false);
    expect(shouldRetry(4, 3)).toBe(false);
  });

  it('returns false when maxRetries is 0', () => {
    expect(shouldRetry(0, 0)).toBe(false);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
