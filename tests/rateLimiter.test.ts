import { describe, expect, it } from 'vitest';
import {
  ChannelRateLimiter,
  TokenBucket,
  checkBudget,
  countWithinWindow,
  estimateCost,
  exceedsFrequencyCap,
} from '../src/core/rateLimiter.js';

describe('TokenBucket', () => {
  it('allows up to its capacity, then stops', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const bucket = new TokenBucket(3, 3, now);
    expect(bucket.take(now)).toBe(true);
    expect(bucket.take(now)).toBe(true);
    expect(bucket.take(now)).toBe(true);
    expect(bucket.take(now)).toBe(false);
  });

  it('refills over time', () => {
    const start = new Date('2026-03-10T12:00:00Z');
    const bucket = new TokenBucket(60, 60, start);
    for (let i = 0; i < 60; i += 1) bucket.take(start);
    expect(bucket.take(start)).toBe(false);

    const later = new Date(start.getTime() + 30_000); // half a minute -> 30 tokens
    expect(bucket.remaining(later)).toBe(30);
    expect(bucket.take(later)).toBe(true);
  });

  it('never refills beyond capacity', () => {
    const start = new Date('2026-03-10T12:00:00Z');
    const bucket = new TokenBucket(10, 10, start);
    const muchLater = new Date(start.getTime() + 60 * 60 * 1000);
    expect(bucket.remaining(muchLater)).toBe(10);
  });

  it('does not consume a token when reporting availability', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const bucket = new TokenBucket(1, 1, now);
    expect(bucket.available(now)).toBe(true);
    expect(bucket.available(now)).toBe(true);
    expect(bucket.take(now)).toBe(true);
    expect(bucket.available(now)).toBe(false);
  });
});

describe('ChannelRateLimiter', () => {
  it('keeps a separate budget per channel', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const limiter = new ChannelRateLimiter(1, () => now);
    expect(limiter.take('email')).toBe(true);
    expect(limiter.take('email')).toBe(false);
    expect(limiter.take('sms')).toBe(true);
  });
});

describe('frequency cap', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

  it('counts only messages inside the rolling window', () => {
    const stamps = [daysAgo(1), daysAgo(3), daysAgo(6), daysAgo(8), daysAgo(30)];
    expect(countWithinWindow(stamps, now, 7)).toBe(3);
  });

  it('blocks at the cap, not above it', () => {
    const stamps = [daysAgo(1), daysAgo(2)];
    expect(exceedsFrequencyCap(stamps, now, 7, 2)).toBe(true);
    expect(exceedsFrequencyCap([daysAgo(1)], now, 7, 2)).toBe(false);
  });

  it('ignores timestamps in the future', () => {
    const future = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    expect(countWithinWindow([future], now, 7)).toBe(0);
  });

  it('accepts ISO strings as well as Dates', () => {
    expect(countWithinWindow([daysAgo(1).toISOString()], now, 7)).toBe(1);
  });
});

describe('budget ceiling', () => {
  it('allows a batch that fits under the ceiling', () => {
    const decision = checkBudget({ spentTodayUsd: 0, ceilingUsd: 50 }, 'email', 1000);
    expect(decision.allowed).toBe(true);
  });

  it('blocks a batch that would cross the ceiling, before sending any of it', () => {
    const decision = checkBudget({ spentTodayUsd: 49.9, ceilingUsd: 50 }, 'sms', 100);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/ceiling/);
    expect(decision.reason).toMatch(/paused/i);
  });

  it('accounts for what has already been spent today', () => {
    const decision = checkBudget({ spentTodayUsd: 50, ceilingUsd: 50 }, 'email', 1);
    expect(decision.allowed).toBe(false);
  });

  it('treats push as free', () => {
    expect(estimateCost('push', 10_000)).toBe(0);
    expect(checkBudget({ spentTodayUsd: 50, ceilingUsd: 50 }, 'push', 10_000).allowed).toBe(true);
  });

  it('prices SMS above email', () => {
    expect(estimateCost('sms', 100)).toBeGreaterThan(estimateCost('email', 100));
  });
});
