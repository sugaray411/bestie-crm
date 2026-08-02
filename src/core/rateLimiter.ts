import type { Channel } from '../types.js';

/**
 * Send-rate ceilings and spend ceilings (§7.7). Pure and clock-injected: every
 * function takes `now`, so the tests do not sleep and the behaviour is
 * deterministic.
 */

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    now: Date = new Date(),
  ) {
    this.tokens = capacity;
    this.lastRefill = now.getTime();
  }

  private refill(now: Date): void {
    const elapsedMs = now.getTime() - this.lastRefill;
    if (elapsedMs <= 0) return;
    const gained = (elapsedMs / 60_000) * this.refillPerMinute;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefill = now.getTime();
  }

  available(now: Date = new Date()): boolean {
    this.refill(now);
    return this.tokens >= 1;
  }

  /** Consumes one token; returns false (and consumes nothing) when empty. */
  take(now: Date = new Date()): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  remaining(now: Date = new Date()): number {
    this.refill(now);
    return Math.floor(this.tokens);
  }
}

export class ChannelRateLimiter {
  private readonly buckets = new Map<Channel, TokenBucket>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private bucket(channel: Channel): TokenBucket {
    let bucket = this.buckets.get(channel);
    if (!bucket) {
      bucket = new TokenBucket(this.perMinute, this.perMinute, this.now());
      this.buckets.set(channel, bucket);
    }
    return bucket;
  }

  available(channel: Channel): boolean {
    return this.bucket(channel).available(this.now());
  }

  take(channel: Channel): boolean {
    return this.bucket(channel).take(this.now());
  }

  remaining(channel: Channel): number {
    return this.bucket(channel).remaining(this.now());
  }
}

// ---------------------------------------------------------------------------
// Frequency cap (§7.6): at most N messages per contact per rolling window.
// ---------------------------------------------------------------------------

export function countWithinWindow(
  timestamps: ReadonlyArray<Date | string>,
  now: Date,
  windowDays: number,
): number {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  return timestamps.filter((t) => {
    const ms = (t instanceof Date ? t : new Date(t)).getTime();
    return Number.isFinite(ms) && ms >= cutoff && ms <= now.getTime();
  }).length;
}

export function exceedsFrequencyCap(
  timestamps: ReadonlyArray<Date | string>,
  now: Date,
  windowDays: number,
  cap: number,
): boolean {
  return countWithinWindow(timestamps, now, windowDays) >= cap;
}

// ---------------------------------------------------------------------------
// Daily spend ceiling (§7.7)
// ---------------------------------------------------------------------------

/** Rough per-message costs, used for the budget ceiling rather than billing. */
export const CHANNEL_COST_USD: Record<Channel, number> = {
  email: 0.0004,
  sms: 0.0079,
  push: 0,
};

export interface BudgetState {
  spentTodayUsd: number;
  ceilingUsd: number;
}

export interface BudgetDecision {
  allowed: boolean;
  projectedSpendUsd: number;
  remainingUsd: number;
  reason?: string;
}

/**
 * Checks a whole batch before it starts, because discovering the ceiling
 * halfway through a 10,000-contact campaign is how you get a half-sent send.
 */
export function checkBudget(
  state: BudgetState,
  channel: Channel,
  messageCount: number,
): BudgetDecision {
  const cost = (CHANNEL_COST_USD[channel] ?? 0) * messageCount;
  const projected = state.spentTodayUsd + cost;
  const remaining = state.ceilingUsd - state.spentTodayUsd;
  if (projected > state.ceilingUsd) {
    return {
      allowed: false,
      projectedSpendUsd: round5(projected),
      remainingUsd: round5(Math.max(0, remaining)),
      reason:
        `Sending ${messageCount} ${channel} message(s) would cost ~$${round5(cost)} and take today's spend to ` +
        `$${round5(projected)}, above the $${state.ceilingUsd} ceiling. Campaign paused.`,
    };
  }
  return {
    allowed: true,
    projectedSpendUsd: round5(projected),
    remainingUsd: round5(remaining - cost),
  };
}

export function estimateCost(channel: Channel, messageCount: number): number {
  return round5((CHANNEL_COST_USD[channel] ?? 0) * messageCount);
}

function round5(n: number): number {
  return Math.round(n * 100_000) / 100_000;
}
