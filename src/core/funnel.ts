import type { MessageStatus } from '../types.js';

/** Funnel, campaign and unit-economics math. Pure -- the DB supplies counts. */

export interface FunnelCounts {
  visitors: number;
  signups: number;
  trials: number;
  subscribers: number;
  cancels: number;
}

export interface FunnelMetrics extends FunnelCounts {
  rates: {
    visitorToSignup: number;
    signupToTrial: number;
    trialToSubscriber: number;
    signupToSubscriber: number;
    churn: number;
  };
  netSubscribers: number;
}

const rate = (numerator: number, denominator: number): number =>
  denominator > 0 ? round4(numerator / denominator) : 0;

export function computeFunnel(counts: FunnelCounts): FunnelMetrics {
  return {
    ...counts,
    netSubscribers: counts.subscribers - counts.cancels,
    rates: {
      visitorToSignup: rate(counts.signups, counts.visitors),
      signupToTrial: rate(counts.trials, counts.signups),
      trialToSubscriber: rate(counts.subscribers, counts.trials),
      signupToSubscriber: rate(counts.subscribers, counts.signups),
      churn: rate(counts.cancels, counts.subscribers),
    },
  };
}

// ---------------------------------------------------------------------------
// Campaign performance
// ---------------------------------------------------------------------------

export type StatusCounts = Partial<Record<MessageStatus, number>>;

export interface CampaignMetrics {
  attempted: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  failed: number;
  skipped: number;
  skippedBreakdown: Record<string, number>;
  rates: {
    delivery: number;
    open: number;
    click: number;
    bounce: number;
    skip: number;
  };
}

export function computeCampaignMetrics(counts: StatusCounts): CampaignMetrics {
  const get = (k: MessageStatus): number => counts[k] ?? 0;

  const skippedBreakdown: Record<string, number> = {};
  let skipped = 0;
  for (const [status, count] of Object.entries(counts)) {
    if (status.startsWith('skipped_') && count) {
      skippedBreakdown[status] = count;
      skipped += count;
    }
  }

  // "delivered" is a superset in funnel terms: an opened message was delivered,
  // even when the provider only ever reported the later event.
  const opened = get('opened') + get('clicked');
  const delivered = get('delivered') + opened;
  const sent = get('sent') + delivered;
  const bounced = get('bounced');
  const failed = get('failed');
  const attempted = sent + bounced + failed + get('queued');

  return {
    attempted,
    sent,
    delivered,
    opened,
    clicked: get('clicked'),
    bounced,
    failed,
    skipped,
    skippedBreakdown,
    rates: {
      delivery: rate(delivered, attempted),
      open: rate(opened, delivered),
      click: rate(get('clicked'), delivered),
      bounce: rate(bounced, attempted),
      skip: rate(skipped, attempted + skipped),
    },
  };
}

// ---------------------------------------------------------------------------
// LTV / CAC (§5 Analytics)
// ---------------------------------------------------------------------------

export interface LtvCacInput {
  /** Average revenue per paying user per month, in USD. */
  arpuMonthlyUsd: number;
  /** Gross margin as a fraction, e.g. 0.7 after API and store fees. */
  grossMargin: number;
  /** Monthly logo churn as a fraction, e.g. 0.05. */
  monthlyChurnRate: number;
  /** Marketing + acquisition spend over the period, in USD. */
  spendUsd: number;
  /** Customers acquired in the same period. */
  newCustomers: number;
}

export interface LtvCacMetrics {
  ltvUsd: number;
  cacUsd: number;
  ltvCacRatio: number;
  paybackMonths: number;
  averageLifetimeMonths: number;
  notes: string[];
}

/**
 * LTV = ARPU x margin / churn -- the standard subscription approximation. Zero
 * churn implies infinite lifetime, which is a modelling artefact rather than a
 * fact, so it is reported as such instead of dividing by zero.
 */
export function computeLtvCac(input: LtvCacInput): LtvCacMetrics {
  const notes: string[] = [];
  const contributionPerMonth = input.arpuMonthlyUsd * input.grossMargin;

  let lifetimeMonths: number;
  if (input.monthlyChurnRate > 0) {
    lifetimeMonths = 1 / input.monthlyChurnRate;
  } else {
    lifetimeMonths = 0;
    notes.push('Monthly churn is 0, so lifetime cannot be estimated. LTV is reported as 0 rather than infinite.');
  }

  const ltv = round2(contributionPerMonth * lifetimeMonths);
  const cac = input.newCustomers > 0 ? round2(input.spendUsd / input.newCustomers) : 0;
  if (input.newCustomers === 0 && input.spendUsd > 0) {
    notes.push(`No customers acquired against $${input.spendUsd} of spend, so CAC is undefined (reported as 0).`);
  }

  const paybackMonths = contributionPerMonth > 0 ? round2(cac / contributionPerMonth) : 0;
  const ratio = cac > 0 ? round2(ltv / cac) : 0;

  if (ratio > 0 && ratio < 1) {
    notes.push('LTV is below CAC: every acquired customer currently loses money.');
  } else if (ratio >= 3) {
    notes.push('LTV:CAC is at or above the 3:1 benchmark.');
  }

  return {
    ltvUsd: ltv,
    cacUsd: cac,
    ltvCacRatio: ratio,
    paybackMonths,
    averageLifetimeMonths: round2(lifetimeMonths),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Channel attribution
// ---------------------------------------------------------------------------

export interface ChannelRow {
  source: string;
  contacts: number;
  signups: number;
  subscribers: number;
}

export interface RankedChannel extends ChannelRow {
  conversionRate: number;
}

export function rankChannels(rows: readonly ChannelRow[]): RankedChannel[] {
  return rows
    .map((r) => ({ ...r, conversionRate: rate(r.subscribers, r.contacts) }))
    .sort((a, b) =>
      b.subscribers - a.subscribers || b.conversionRate - a.conversionRate || a.source.localeCompare(b.source),
    );
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
