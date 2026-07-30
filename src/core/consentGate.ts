import type { Channel, ConsentBasis, ConsentRecord, SkipReason } from '../types.js';
import { isQuietHour } from './compliance.js';

/**
 * The gate every outbound message passes through. Deliberately pure: no DB, no
 * network, no clock of its own. Callers gather the facts, this decides.
 */

export interface ResolvedConsent {
  status: 'granted' | 'revoked' | 'none';
  basis?: ConsentBasis;
  ts?: Date;
}

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/**
 * The latest row per (contact, channel) wins -- consent history is append-only,
 * so "granted then revoked" must resolve to revoked no matter what order the
 * rows arrive in.
 */
export function resolveConsent(records: readonly ConsentRecord[], channel: Channel): ResolvedConsent {
  let latest: ConsentRecord | undefined;
  for (const record of records) {
    if (record.channel !== channel) continue;
    if (latest === undefined || toDate(record.ts).getTime() > toDate(latest.ts).getTime()) {
      latest = record;
    }
  }
  if (latest === undefined) return { status: 'none' };
  return { status: latest.status, basis: latest.basis, ts: toDate(latest.ts) };
}

/**
 * GDPR/ePrivacy territories where "existing customer" or "referral" is not a
 * sufficient basis for marketing -- we require an explicit opt-in (§7.5).
 */
export const EXPLICIT_OPT_IN_COUNTRIES = new Set([
  // EEA
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES',
  'SE', 'IS', 'LI', 'NO',
  // UK
  'GB', 'UK',
]);

export function requiresExplicitOptIn(country: string | null | undefined): boolean {
  if (!country) return false;
  return EXPLICIT_OPT_IN_COUNTRIES.has(country.trim().toUpperCase());
}

export interface GateContact {
  id: string;
  country?: string | null;
  timezone?: string | null;
  /** The delivery address for the channel in question; null means unreachable. */
  address?: string | null;
}

export interface GateInput {
  channel: Channel;
  contact: GateContact;
  consents: readonly ConsentRecord[];
  suppressed: boolean;
  /** Messages already sent to this contact inside the frequency window. */
  recentMessageCount: number;
  frequencyCap: number;
  now: Date;
  quietHours: { start: number; end: number };
  /** False when the per-channel send-rate bucket is empty. */
  rateLimitAvailable: boolean;
}

export interface GateDecision {
  allowed: boolean;
  reason?: SkipReason;
  detail?: string;
}

const ALLOWED: GateDecision = { allowed: true };

/**
 * Order matters for the *explanation*, not the outcome: suppression and consent
 * both block absolutely, but a contact who unsubscribed should be reported as
 * suppressed rather than as merely lacking consent.
 */
export function evaluateGate(input: GateInput): GateDecision {
  const { channel, contact, consents, now, quietHours } = input;

  if (input.suppressed) {
    return {
      allowed: false,
      reason: 'skipped_suppressed',
      // Deliberately no address here: this string is returned in tool results
      // and written to crm.messages.error, neither of which should carry PII.
      detail: `This contact's ${channel} address is on the suppression list.`,
    };
  }

  const consent = resolveConsent(consents, channel);
  if (consent.status !== 'granted') {
    return {
      allowed: false,
      reason: 'skipped_no_consent',
      detail:
        consent.status === 'revoked'
          ? `Consent for ${channel} was revoked.`
          : `No ${channel} consent on record.`,
    };
  }

  if (requiresExplicitOptIn(contact.country) && consent.basis !== 'opt_in') {
    return {
      allowed: false,
      reason: 'skipped_region_requires_opt_in',
      detail: `${contact.country} requires an explicit opt-in; basis on record is "${consent.basis}".`,
    };
  }

  if (!contact.address) {
    return {
      allowed: false,
      reason: 'skipped_no_address',
      detail: `Contact has no ${channel} address.`,
    };
  }

  // Quiet hours apply to the interruptive channels only; email can land at 3am
  // without waking anyone (§7.6).
  if (channel === 'sms' || channel === 'push') {
    const quiet = isQuietHour(now, contact.timezone ?? 'UTC', quietHours.start, quietHours.end);
    if (quiet.quiet) {
      return {
        allowed: false,
        reason: 'skipped_quiet_hours',
        detail: `Local time ${quiet.localHour}:00 in ${quiet.timezone} is outside ${quietHours.start}:00-${quietHours.end}:00.`,
      };
    }
  }

  if (input.recentMessageCount >= input.frequencyCap) {
    return {
      allowed: false,
      reason: 'skipped_frequency_cap',
      detail: `Already sent ${input.recentMessageCount} message(s); cap is ${input.frequencyCap}.`,
    };
  }

  if (!input.rateLimitAvailable) {
    return {
      allowed: false,
      reason: 'skipped_rate_limit',
      detail: 'Per-channel send rate exhausted; retry shortly.',
    };
  }

  return ALLOWED;
}
