import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySvixSignature, verifyTwilioSignature } from '../src/core/webhookAuth.js';

const NOW = new Date('2026-03-10T12:00:00Z');
const SECRET = `whsec_${Buffer.from('super-secret-key').toString('base64')}`;

function signSvix(body: string, id: string, timestamp: string, secret = SECRET): string {
  const key = Buffer.from(secret.slice(6), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

describe('verifySvixSignature (Resend)', () => {
  const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'abc' } });
  const id = 'msg_123';
  const ts = String(Math.floor(NOW.getTime() / 1000));

  it('accepts a correctly signed payload', () => {
    const result = verifySvixSignature(
      body,
      { id, timestamp: ts, signature: signSvix(body, id, ts) },
      SECRET,
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = signSvix(body, id, ts);
    const tampered = JSON.stringify({ type: 'email.delivered', data: { email_id: 'someone-elses' } });
    expect(verifySvixSignature(tampered, { id, timestamp: ts, signature }, SECRET, NOW).ok).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const otherSecret = `whsec_${Buffer.from('attacker-key').toString('base64')}`;
    const signature = signSvix(body, id, ts, otherSecret);
    expect(verifySvixSignature(body, { id, timestamp: ts, signature }, SECRET, NOW).ok).toBe(false);
  });

  it('rejects a replayed payload outside the time tolerance', () => {
    const oldTs = String(Math.floor(NOW.getTime() / 1000) - 600); // 10 minutes ago
    const signature = signSvix(body, id, oldTs);
    const result = verifySvixSignature(body, { id, timestamp: oldTs, signature }, SECRET, NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/tolerance/);
  });

  it('accepts a payload just inside the tolerance', () => {
    const recentTs = String(Math.floor(NOW.getTime() / 1000) - 120);
    const signature = signSvix(body, id, recentTs);
    expect(verifySvixSignature(body, { id, timestamp: recentTs, signature }, SECRET, NOW).ok).toBe(true);
  });

  it('accepts when one of several offered signatures matches', () => {
    const signature = `v1,ZmFrZQ== ${signSvix(body, id, ts)}`;
    expect(verifySvixSignature(body, { id, timestamp: ts, signature }, SECRET, NOW).ok).toBe(true);
  });

  it.each([
    ['id', { id: undefined, timestamp: ts, signature: 'v1,x' }],
    ['timestamp', { id, timestamp: undefined, signature: 'v1,x' }],
    ['signature', { id, timestamp: ts, signature: undefined }],
  ])('rejects a request missing the svix-%s header', (_name, headers) => {
    expect(verifySvixSignature(body, headers, SECRET, NOW).ok).toBe(false);
  });

  it('rejects a malformed timestamp rather than treating it as epoch zero', () => {
    const result = verifySvixSignature(body, { id, timestamp: 'not-a-number', signature: 'v1,x' }, SECRET, NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Malformed/);
  });
});

describe('verifyTwilioSignature', () => {
  const url = 'https://crm.example.com/webhooks/twilio';
  const token = 'twilio-auth-token';
  const params = { From: '+15551234567', Body: 'STOP', MessageSid: 'SM123' };

  const sign = (u: string, p: Record<string, string>, t = token): string => {
    const payload = Object.keys(p).sort().reduce((acc, k) => acc + k + p[k], u);
    return createHmac('sha1', t).update(Buffer.from(payload, 'utf8')).digest('base64');
  };

  it('accepts a correctly signed request', () => {
    expect(verifyTwilioSignature(url, params, sign(url, params), token).ok).toBe(true);
  });

  it('rejects when a parameter was altered', () => {
    const signature = sign(url, params);
    const altered = { ...params, From: '+15559999999' };
    expect(verifyTwilioSignature(url, altered, signature, token).ok).toBe(false);
  });

  it('rejects when the URL does not match the one Twilio signed', () => {
    const signature = sign(url, params);
    const result = verifyTwilioSignature('https://crm.example.com/webhooks/twilio/', params, signature, token);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/CRM_PUBLIC_URL/);
  });

  it('rejects a signature made with a different auth token', () => {
    expect(verifyTwilioSignature(url, params, sign(url, params, 'wrong-token'), token).ok).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyTwilioSignature(url, params, undefined, token).ok).toBe(false);
  });

  it('is insensitive to parameter ordering, as the spec requires', () => {
    const reordered = { MessageSid: 'SM123', Body: 'STOP', From: '+15551234567' };
    expect(verifyTwilioSignature(url, reordered, sign(url, params), token).ok).toBe(true);
  });
});
