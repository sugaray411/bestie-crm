import { describe, expect, it } from 'vitest';
import {
  computeCampaignMetrics,
  computeFunnel,
  computeLtvCac,
  rankChannels,
} from '../src/core/funnel.js';

describe('computeFunnel', () => {
  it('computes stage-to-stage conversion rates', () => {
    const metrics = computeFunnel({ visitors: 1000, signups: 200, trials: 100, subscribers: 25, cancels: 5 });
    expect(metrics.rates.visitorToSignup).toBe(0.2);
    expect(metrics.rates.signupToTrial).toBe(0.5);
    expect(metrics.rates.trialToSubscriber).toBe(0.25);
    expect(metrics.rates.signupToSubscriber).toBe(0.125);
    expect(metrics.rates.churn).toBe(0.2);
    expect(metrics.netSubscribers).toBe(20);
  });

  it('reports zero rather than dividing by zero on an empty funnel', () => {
    const metrics = computeFunnel({ visitors: 0, signups: 0, trials: 0, subscribers: 0, cancels: 0 });
    expect(Object.values(metrics.rates).every((r) => r === 0)).toBe(true);
  });
});

describe('computeCampaignMetrics', () => {
  it('rolls later events up into the earlier stages', () => {
    const metrics = computeCampaignMetrics({ sent: 50, delivered: 30, opened: 15, clicked: 5, bounced: 2 });
    expect(metrics.opened).toBe(20); // opened + clicked
    expect(metrics.delivered).toBe(50); // delivered + opened + clicked
    expect(metrics.sent).toBe(100);
    expect(metrics.attempted).toBe(102);
  });

  it('separates skips from failures and breaks them down by reason', () => {
    const metrics = computeCampaignMetrics({
      sent: 40,
      failed: 2,
      skipped_no_consent: 30,
      skipped_suppressed: 20,
      skipped_quiet_hours: 8,
    });
    expect(metrics.skipped).toBe(58);
    expect(metrics.failed).toBe(2);
    expect(metrics.skippedBreakdown).toEqual({
      skipped_no_consent: 30,
      skipped_suppressed: 20,
      skipped_quiet_hours: 8,
    });
    expect(metrics.rates.skip).toBeCloseTo(58 / 100, 4);
  });

  it('handles a campaign where everyone was skipped', () => {
    const metrics = computeCampaignMetrics({ skipped_no_consent: 10 });
    expect(metrics.attempted).toBe(0);
    expect(metrics.skipped).toBe(10);
    expect(metrics.rates.delivery).toBe(0);
    expect(metrics.rates.skip).toBe(1);
  });
});

describe('computeLtvCac', () => {
  const base = {
    arpuMonthlyUsd: 9.99,
    grossMargin: 0.6,
    monthlyChurnRate: 0.05,
    spendUsd: 1000,
    newCustomers: 40,
  };

  it('computes LTV, CAC, ratio and payback', () => {
    const metrics = computeLtvCac(base);
    expect(metrics.averageLifetimeMonths).toBe(20);
    expect(metrics.ltvUsd).toBeCloseTo(119.88, 2); // 9.99 * 0.6 * 20
    expect(metrics.cacUsd).toBe(25);
    expect(metrics.ltvCacRatio).toBeCloseTo(4.8, 1);
    expect(metrics.paybackMonths).toBeCloseTo(4.17, 1);
  });

  it('flags a ratio at or above the 3:1 benchmark', () => {
    expect(computeLtvCac(base).notes.join(' ')).toMatch(/3:1 benchmark/);
  });

  it('flags customers that lose money', () => {
    const metrics = computeLtvCac({ ...base, spendUsd: 10_000 });
    expect(metrics.ltvCacRatio).toBeLessThan(1);
    expect(metrics.notes.join(' ')).toMatch(/below CAC/);
  });

  it('does not report an infinite lifetime when churn is zero', () => {
    const metrics = computeLtvCac({ ...base, monthlyChurnRate: 0 });
    expect(Number.isFinite(metrics.ltvUsd)).toBe(true);
    expect(metrics.ltvUsd).toBe(0);
    expect(metrics.notes.join(' ')).toMatch(/cannot be estimated/);
  });

  it('does not divide by zero when nothing was acquired', () => {
    const metrics = computeLtvCac({ ...base, newCustomers: 0 });
    expect(metrics.cacUsd).toBe(0);
    expect(metrics.notes.join(' ')).toMatch(/CAC is undefined/);
  });
});

describe('rankChannels', () => {
  it('ranks by subscribers, then conversion rate', () => {
    const ranked = rankChannels([
      { source: 'organic', contacts: 1000, signups: 200, subscribers: 20 },
      { source: 'referral', contacts: 100, signups: 60, subscribers: 30 },
      { source: 'ads', contacts: 500, signups: 50, subscribers: 20 },
    ]);
    expect(ranked.map((r) => r.source)).toEqual(['referral', 'ads', 'organic']);
    expect(ranked[0]?.conversionRate).toBe(0.3);
  });

  it('handles a source with no contacts without dividing by zero', () => {
    const ranked = rankChannels([{ source: 'unknown', contacts: 0, signups: 0, subscribers: 0 }]);
    expect(ranked[0]?.conversionRate).toBe(0);
  });
});
