import { describe, expect, it } from 'vitest';
import { evaluateGate, requiresExplicitOptIn, resolveConsent } from '../src/core/consentGate.js';
import type { ConsentRecord } from '../src/types.js';

const consent = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  channel: 'email',
  status: 'granted',
  basis: 'opt_in',
  ts: '2026-01-01T00:00:00Z',
  ...over,
});

const baseInput = {
  channel: 'email' as const,
  contact: { id: 'c1', country: 'US', timezone: 'America/New_York', address: 'a@example.com' },
  consents: [consent()],
  suppressed: false,
  recentMessageCount: 0,
  frequencyCap: 2,
  now: new Date('2026-03-10T15:00:00Z'), // 11:00 in New York
  quietHours: { start: 9, end: 20 },
  rateLimitAvailable: true,
};

describe('resolveConsent', () => {
  it('reports no consent when nothing is on record', () => {
    expect(resolveConsent([], 'email').status).toBe('none');
  });

  it('takes the latest record, whatever order the rows arrive in', () => {
    const records = [
      consent({ status: 'revoked', ts: '2026-02-01T00:00:00Z' }),
      consent({ status: 'granted', ts: '2026-01-01T00:00:00Z' }),
    ];
    expect(resolveConsent(records, 'email').status).toBe('revoked');
  });

  it('does not let one channel speak for another', () => {
    const records = [consent({ channel: 'email', status: 'granted' })];
    expect(resolveConsent(records, 'sms').status).toBe('none');
  });
});

describe('evaluateGate', () => {
  it('allows a consented, unsuppressed contact', () => {
    expect(evaluateGate(baseInput)).toEqual({ allowed: true });
  });

  it('skips a contact with no consent', () => {
    const decision = evaluateGate({ ...baseInput, consents: [] });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('skipped_no_consent');
  });

  it('skips a contact whose consent was revoked', () => {
    const decision = evaluateGate({
      ...baseInput,
      consents: [consent(), consent({ status: 'revoked', ts: '2026-02-01T00:00:00Z' })],
    });
    expect(decision.reason).toBe('skipped_no_consent');
    expect(decision.detail).toContain('revoked');
  });

  it('treats suppression as absolute, even with consent granted', () => {
    const decision = evaluateGate({ ...baseInput, suppressed: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('skipped_suppressed');
  });

  it('requires an explicit opt-in for EU/UK contacts', () => {
    const decision = evaluateGate({
      ...baseInput,
      contact: { ...baseInput.contact, country: 'DE' },
      consents: [consent({ basis: 'existing_customer' })],
    });
    expect(decision.reason).toBe('skipped_region_requires_opt_in');
  });

  it('allows an EU contact who did give an explicit opt-in', () => {
    const decision = evaluateGate({
      ...baseInput,
      contact: { ...baseInput.contact, country: 'FR' },
      consents: [consent({ basis: 'opt_in' })],
    });
    expect(decision.allowed).toBe(true);
  });

  it('skips a contact with no address for the channel', () => {
    const decision = evaluateGate({ ...baseInput, contact: { ...baseInput.contact, address: null } });
    expect(decision.reason).toBe('skipped_no_address');
  });

  it('enforces the frequency cap', () => {
    const decision = evaluateGate({ ...baseInput, recentMessageCount: 2, frequencyCap: 2 });
    expect(decision.reason).toBe('skipped_frequency_cap');
  });

  it('skips when the send-rate bucket is empty', () => {
    const decision = evaluateGate({ ...baseInput, rateLimitAvailable: false });
    expect(decision.reason).toBe('skipped_rate_limit');
  });

  describe('quiet hours', () => {
    const sms = {
      ...baseInput,
      channel: 'sms' as const,
      contact: { ...baseInput.contact, address: '+15551234567' },
      consents: [consent({ channel: 'sms' })],
    };

    it('blocks SMS outside 09:00-20:00 local time', () => {
      // 03:00 UTC is 22:00 the previous day in New York.
      const decision = evaluateGate({ ...sms, now: new Date('2026-03-11T03:00:00Z') });
      expect(decision.reason).toBe('skipped_quiet_hours');
    });

    it('allows SMS inside the window', () => {
      expect(evaluateGate({ ...sms, now: new Date('2026-03-10T15:00:00Z') }).allowed).toBe(true);
    });

    it('uses the contact timezone, not the server timezone', () => {
      // 15:00 UTC is 11:00 in New York but 00:00 in Tokyo.
      const tokyo = {
        ...sms,
        contact: { ...sms.contact, timezone: 'Asia/Tokyo' },
        now: new Date('2026-03-10T15:00:00Z'),
      };
      expect(evaluateGate(tokyo).reason).toBe('skipped_quiet_hours');
    });

    it('does not apply quiet hours to email', () => {
      const decision = evaluateGate({ ...baseInput, now: new Date('2026-03-11T07:00:00Z') });
      expect(decision.allowed).toBe(true);
    });
  });
});

describe('requiresExplicitOptIn', () => {
  it.each(['DE', 'de', 'GB', 'FR', 'NO'])('requires opt-in for %s', (country) => {
    expect(requiresExplicitOptIn(country)).toBe(true);
  });

  it.each(['US', 'CA', 'AU', null, undefined, ''])('does not require opt-in for %s', (country) => {
    expect(requiresExplicitOptIn(country)).toBe(false);
  });
});
