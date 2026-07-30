import { describe, expect, it } from 'vitest';
import {
  contactVars,
  prepareMessage,
  renderTemplate,
  templateVariables,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from '../src/core/render.js';
import { redactArgs, maskEmail, maskPhone } from '../src/core/audit.js';
import { approvalToken, verifyApprovalToken } from '../src/core/sendPipeline.js';
import type { Contact } from '../src/types.js';

const UNSUB = 'https://bestie.app/u/c1?t=abc';
const ADDRESS = 'Bestie Labs, 123 Example St, San Francisco, CA 94110';

const contact: Contact = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'jordan@example.com',
  phone: '+15551234567',
  push_token: null,
  name: 'Jordan Lee',
  source: 'signup form',
  locale: 'en-US',
  country: 'US',
  timezone: 'America/New_York',
  tags: [],
  lifecycle_stage: 'trial',
  rc_app_user_id: null,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('renderTemplate', () => {
  it('substitutes variables', () => {
    const result = renderTemplate('Hi {{first_name}}, ready?', { first_name: 'Jordan' });
    expect(result.text).toBe('Hi Jordan, ready?');
    expect(result.missingVariables).toEqual([]);
  });

  it('never leaves a raw placeholder in the output, and reports what was missing', () => {
    const result = renderTemplate('Hi {{first_name}}, your code is {{referral_code}}.', {});
    expect(result.text).not.toContain('{{');
    expect(result.missingVariables.sort()).toEqual(['first_name', 'referral_code']);
  });

  it('lists the variables a template uses', () => {
    expect(templateVariables('{{a}} and {{ b }} and {{a}}').sort()).toEqual(['a', 'b']);
  });

  it('derives a first name and a safe fallback', () => {
    expect(contactVars(contact).first_name).toBe('Jordan');
    expect(contactVars({ ...contact, name: null }).first_name).toBe('there');
  });
});

describe('prepareMessage', () => {
  it('attaches the unsubscribe link and address to an email', () => {
    const prepared = prepareMessage({
      channel: 'email',
      subject: 'Hi {{first_name}}',
      body: 'Show Bestie the problem on a video call.',
      vars: contactVars(contact),
      unsubscribeUrl: UNSUB,
      physicalAddress: ADDRESS,
    });
    expect(prepared.subject).toBe('Hi Jordan');
    expect(prepared.body).toContain(UNSUB);
    expect(prepared.body).toContain(ADDRESS);
    expect(prepared.complianceIssues).toEqual([]);
  });

  it('reports the compliance issue when the unsubscribe URL is not configured', () => {
    const prepared = prepareMessage({
      channel: 'email',
      body: 'Hello.',
      vars: {},
      unsubscribeUrl: '',
      physicalAddress: ADDRESS,
    });
    expect(prepared.complianceIssues.join(' ')).toMatch(/unsubscribe/i);
  });

  it('attaches the STOP notice to an SMS', () => {
    const prepared = prepareMessage({
      channel: 'sms',
      body: 'Your trial ends tomorrow.',
      vars: {},
      unsubscribeUrl: UNSUB,
      physicalAddress: ADDRESS,
    });
    expect(prepared.body).toContain('Reply STOP to opt out.');
    expect(prepared.complianceIssues).toEqual([]);
  });

  it('surfaces an untruthful claim rather than sending it', () => {
    const prepared = prepareMessage({
      channel: 'sms',
      body: 'Unlimited free video calls, forever!',
      vars: {},
      unsubscribeUrl: UNSUB,
      physicalAddress: ADDRESS,
    });
    expect(prepared.truthfulnessViolations.join(' ')).toMatch(/no-unlimited-free-video/);
  });
});

describe('unsubscribe tokens', () => {
  it('produces a stable, verifiable token', () => {
    const url = unsubscribeUrl('https://bestie.app/u', contact.id, 'secret');
    const token = new URL(url).searchParams.get('t')!;
    expect(verifyUnsubscribeToken(contact.id, token, 'secret')).toBe(true);
  });

  it('rejects a token minted for a different contact', () => {
    const url = unsubscribeUrl('https://bestie.app/u', contact.id, 'secret');
    const token = new URL(url).searchParams.get('t')!;
    expect(verifyUnsubscribeToken('22222222-2222-2222-2222-222222222222', token, 'secret')).toBe(false);
  });

  it('returns an empty string when no base URL is configured', () => {
    expect(unsubscribeUrl('', contact.id, 'secret')).toBe('');
  });
});

describe('bulk approval tokens', () => {
  const now = new Date('2026-03-10T12:00:00Z');

  it('validates a token for the same campaign and recipient count', () => {
    const token = approvalToken('camp-1', 500, 'secret', now);
    expect(verifyApprovalToken(token, 'camp-1', 500, 'secret', now)).toBe(true);
  });

  it('rejects a token replayed against a larger send', () => {
    const token = approvalToken('camp-1', 500, 'secret', now);
    expect(verifyApprovalToken(token, 'camp-1', 5000, 'secret', now)).toBe(false);
  });

  it('rejects a token replayed against a different campaign', () => {
    const token = approvalToken('camp-1', 500, 'secret', now);
    expect(verifyApprovalToken(token, 'camp-2', 500, 'secret', now)).toBe(false);
  });

  it('expires the next day', () => {
    const token = approvalToken('camp-1', 500, 'secret', now);
    const tomorrow = new Date('2026-03-11T12:00:00Z');
    expect(verifyApprovalToken(token, 'camp-1', 500, 'secret', tomorrow)).toBe(false);
  });

  it('rejects a missing token', () => {
    expect(verifyApprovalToken(undefined, 'camp-1', 500, 'secret', now)).toBe(false);
  });
});

describe('audit redaction', () => {
  it('masks an email but keeps the domain for debugging', () => {
    expect(maskEmail('jordan@example.com')).toBe('j*****@example.com');
  });

  it('keeps only the last four digits of a phone number', () => {
    expect(maskPhone('+1 555 123 4567')).toBe('***4567');
  });

  it('redacts secrets, addresses and message bodies', () => {
    const redacted = redactArgs({
      email: 'jordan@example.com',
      phone: '+15551234567',
      api_key: 'sk-live-123',
      approval_token: 'abc',
      body: 'x'.repeat(300),
      contact_id: 'keep-me',
      nested: { authorization: 'Bearer xyz', to: 'someone@example.com' },
    }) as Record<string, unknown>;

    expect(redacted.email).toBe('j*****@example.com');
    expect(redacted.phone).toBe('***4567');
    expect(redacted.api_key).toBe('[redacted]');
    expect(redacted.approval_token).toBe('[redacted]');
    expect(redacted.body).toBe('[300 chars omitted]');
    expect(redacted.contact_id).toBe('keep-me');
    expect((redacted.nested as Record<string, unknown>).authorization).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).to).toBe('s******@example.com');
  });

  it('truncates long arrays instead of logging a whole import', () => {
    const redacted = redactArgs(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(redacted).toHaveLength(21);
    expect(redacted[20]).toBe('[+80 more]');
  });
});
