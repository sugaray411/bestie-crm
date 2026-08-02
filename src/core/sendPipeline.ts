import { createHmac } from 'node:crypto';
import type { ServerContext } from '../context.js';
import type { Channel, Contact, SkipReason } from '../types.js';
import { evaluateGate } from './consentGate.js';
import { checkBudget, estimateCost } from './rateLimiter.js';
import { prepareMessage, contactVars, unsubscribeUrl } from './render.js';
import {
  consentsForMany,
  insertMessage,
  recentMessageCounts,
  spentTodayUsd,
  suppressedSet,
} from '../db/repo.js';

/**
 * The one path from "a list of contacts" to "messages actually sent". Both the
 * campaign tools and the single-send tools go through here, so there is exactly
 * one implementation of the consent -> suppression -> quiet hours -> frequency
 * -> rate limit -> budget gate.
 */

export function addressFor(contact: Contact, channel: Channel): string | null {
  if (channel === 'email') return contact.email;
  if (channel === 'sms') return contact.phone;
  return contact.push_token;
}

export interface PlannedSend {
  contact_id: string;
  /** Masked for display; the real address never leaves the pipeline. */
  address: string;
  allowed: boolean;
  skip_reason?: SkipReason;
  detail?: string;
  preview?: string;
  subject?: string;
}

export interface SendPlan {
  channel: Channel;
  dry_run: boolean;
  plan: PlannedSend[];
  summary: {
    total: number;
    sendable: number;
    skipped: number;
    skipped_by_reason: Record<string, number>;
    estimated_cost_usd: number;
    estimated_minutes: number;
  };
  compliance_issues: string[];
  budget: { allowed: boolean; reason?: string; remaining_usd: number };
}

function maskAddress(channel: Channel, address: string): string {
  if (channel === 'email') {
    const at = address.indexOf('@');
    return at > 0 ? `${address.slice(0, 1)}***@${address.slice(at + 1)}` : '***';
  }
  if (channel === 'sms') {
    const digits = address.replace(/\D/g, '');
    return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
  }
  return `${address.slice(0, 12)}...`;
}

export interface BuildPlanInput {
  channel: Channel;
  contacts: Contact[];
  subject?: string | null;
  body: string;
  dryRun: boolean;
  includePreview?: boolean;
}

/**
 * Evaluates the gate for every contact and renders each message, without
 * sending anything. This is exactly what a dry run returns, and exactly what
 * the real send then executes -- so the plan a human approves is the plan that
 * runs.
 */
export async function buildSendPlan(ctx: ServerContext, input: BuildPlanInput): Promise<SendPlan> {
  const { channel, contacts, dryRun } = input;
  const { guardrails } = ctx.config;
  const now = ctx.now();

  const ids = contacts.map((c) => c.id);
  const addresses = contacts
    .map((c) => addressFor(c, channel))
    .filter((a): a is string => a !== null && a !== '');

  const [consentMap, suppressed, recentCounts] = await Promise.all([
    consentsForMany(ctx.db, ids),
    suppressedSet(ctx.db, channel, addresses),
    recentMessageCounts(ctx.db, ids, guardrails.frequencyWindowDays),
  ]);

  const plan: PlannedSend[] = [];
  const complianceIssues = new Set<string>();
  const skippedByReason: Record<string, number> = {};

  for (const contact of contacts) {
    const address = addressFor(contact, channel);
    const decision = evaluateGate({
      channel,
      contact: { id: contact.id, country: contact.country, timezone: contact.timezone, address },
      consents: consentMap.get(contact.id) ?? [],
      suppressed: address ? suppressed.has(address.toLowerCase()) : false,
      recentMessageCount: recentCounts.get(contact.id) ?? 0,
      frequencyCap: guardrails.frequencyCap,
      now,
      quietHours: { start: guardrails.quietHoursStart, end: guardrails.quietHoursEnd },
      // A dry run must not consume send-rate tokens, and reporting a projected
      // rate-limit skip would be noise -- the timing estimate covers it instead.
      rateLimitAvailable: dryRun ? true : ctx.rateLimiter.available(channel),
    });

    const entry: PlannedSend = {
      contact_id: contact.id,
      address: address ? maskAddress(channel, address) : '(none)',
      allowed: decision.allowed,
    };
    if (decision.reason) entry.skip_reason = decision.reason;
    if (decision.detail) entry.detail = decision.detail;

    if (decision.allowed) {
      const prepared = prepareMessage({
        channel,
        subject: input.subject ?? null,
        body: input.body,
        vars: contactVars(contact),
        unsubscribeUrl: unsubscribeUrl(guardrails.unsubscribeBaseUrl, contact.id, ctx.config.bearerToken),
        physicalAddress: guardrails.senderPhysicalAddress,
      });
      for (const issue of prepared.complianceIssues) complianceIssues.add(issue);
      for (const violation of prepared.truthfulnessViolations) complianceIssues.add(violation);
      if (input.includePreview !== false) {
        entry.preview = prepared.body.length > 400 ? `${prepared.body.slice(0, 400)}...` : prepared.body;
        if (prepared.subject) entry.subject = prepared.subject;
      }
    } else if (decision.reason) {
      skippedByReason[decision.reason] = (skippedByReason[decision.reason] ?? 0) + 1;
    }

    plan.push(entry);
  }

  const sendable = plan.filter((p) => p.allowed).length;
  const spent = await spentTodayUsd(ctx.db);
  const budget = checkBudget(
    { spentTodayUsd: spent, ceilingUsd: guardrails.dailySpendCeilingUsd },
    channel,
    sendable,
  );

  return {
    channel,
    dry_run: dryRun,
    plan,
    summary: {
      total: plan.length,
      sendable,
      skipped: plan.length - sendable,
      skipped_by_reason: skippedByReason,
      estimated_cost_usd: estimateCost(channel, sendable),
      estimated_minutes:
        guardrails.sendRatePerMinute > 0
          ? Math.round((sendable / guardrails.sendRatePerMinute) * 100) / 100
          : 0,
    },
    compliance_issues: [...complianceIssues],
    budget: {
      allowed: budget.allowed,
      ...(budget.reason ? { reason: budget.reason } : {}),
      remaining_usd: budget.remainingUsd,
    },
  };
}

export interface ExecuteResult {
  sent: number;
  failed: number;
  skipped: number;
  skipped_by_reason: Record<string, number>;
  cost_usd: number;
  errors: string[];
}

/**
 * Executes a plan. Skips are written to crm.messages too: "we deliberately did
 * not message this person, and here is why" is the record that matters when
 * someone asks why a campaign reached 400 of 1,000 contacts.
 */
export async function executeSendPlan(
  ctx: ServerContext,
  input: BuildPlanInput & { plan: SendPlan; campaignId?: string | null },
): Promise<ExecuteResult> {
  const { channel, plan, campaignId } = input;
  const adapter = ctx.adapters[channel];
  const byId = new Map(input.contacts.map((c) => [c.id, c]));
  const result: ExecuteResult = {
    sent: 0,
    failed: 0,
    skipped: 0,
    skipped_by_reason: {},
    cost_usd: 0,
    errors: [],
  };

  for (const entry of plan.plan) {
    const contact = byId.get(entry.contact_id);
    if (!contact) continue;

    if (!entry.allowed) {
      const reason = entry.skip_reason ?? 'skipped_no_consent';
      await insertMessage(ctx.db, {
        campaign_id: campaignId ?? null,
        contact_id: contact.id,
        channel,
        status: reason,
        error: entry.detail ?? null,
      });
      result.skipped += 1;
      result.skipped_by_reason[reason] = (result.skipped_by_reason[reason] ?? 0) + 1;
      continue;
    }

    // Re-check the rate limit at send time: the plan may have been built minutes
    // ago, and this is the point where a token is actually spent.
    if (!ctx.rateLimiter.take(channel)) {
      await insertMessage(ctx.db, {
        campaign_id: campaignId ?? null,
        contact_id: contact.id,
        channel,
        status: 'skipped_rate_limit',
        error: 'Per-channel send rate exhausted.',
      });
      result.skipped += 1;
      result.skipped_by_reason.skipped_rate_limit = (result.skipped_by_reason.skipped_rate_limit ?? 0) + 1;
      continue;
    }

    const address = addressFor(contact, channel)!;
    const contactUnsubscribeUrl = unsubscribeUrl(
      ctx.config.guardrails.unsubscribeBaseUrl,
      contact.id,
      ctx.config.bearerToken,
    );
    const prepared = prepareMessage({
      channel,
      subject: input.subject ?? null,
      body: input.body,
      vars: contactVars(contact),
      unsubscribeUrl: contactUnsubscribeUrl,
      physicalAddress: ctx.config.guardrails.senderPhysicalAddress,
    });

    const sendResult = await adapter.send({
      to: address,
      subject: prepared.subject,
      body: prepared.body,
      unsubscribeUrl: contactUnsubscribeUrl,
    });

    const cost = sendResult.status === 'sent' ? estimateCost(channel, 1) : 0;
    await insertMessage(ctx.db, {
      campaign_id: campaignId ?? null,
      contact_id: contact.id,
      channel,
      status: sendResult.status === 'sent' ? 'sent' : 'failed',
      provider_id: sendResult.providerId ?? null,
      error: sendResult.error ?? null,
      cost_usd: cost,
    });

    if (sendResult.status === 'sent') {
      result.sent += 1;
      result.cost_usd = Math.round((result.cost_usd + cost) * 100_000) / 100_000;
    } else {
      result.failed += 1;
      if (sendResult.error && result.errors.length < 10) result.errors.push(sendResult.error);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Bulk approval (§7.8)
// ---------------------------------------------------------------------------

/**
 * A single-use-ish approval token bound to this exact plan: the campaign, the
 * recipient count and today's date. It cannot be replayed against a different
 * or larger send, and it expires at midnight UTC.
 *
 * This is a human-in-the-loop speed bump, not a cryptographic authorization
 * boundary: the token is returned in the tool result, so the point is that a
 * person sees the plan and the number before a second, explicit call happens.
 */
export function approvalToken(
  campaignRef: string,
  recipientCount: number,
  secret: string | undefined,
  now: Date,
): string {
  const day = now.toISOString().slice(0, 10);
  return createHmac('sha256', secret ?? 'crm-bulk-approval')
    .update(`${campaignRef}:${recipientCount}:${day}`)
    .digest('hex')
    .slice(0, 24);
}

export function verifyApprovalToken(
  token: string | undefined,
  campaignRef: string,
  recipientCount: number,
  secret: string | undefined,
  now: Date,
): boolean {
  if (!token) return false;
  return token === approvalToken(campaignRef, recipientCount, secret, now);
}
