import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature verification for inbound provider webhooks. Pure and clock-injected
 * so the security-critical part is tested without a network.
 *
 * These endpoints are necessarily public -- providers cannot present our bearer
 * token -- so the signature IS the authentication. An unverified webhook route
 * lets anyone suppress arbitrary addresses or forge delivery events.
 */

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Resend (Svix)
// ---------------------------------------------------------------------------

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Resend signs with Svix: base64(HMAC-SHA256(secret, "{id}.{timestamp}.{body}")).
 * The secret is `whsec_<base64>`; the bytes after the prefix are the key.
 * The signature header may carry several space-separated `v1,<sig>` values.
 */
export function verifySvixSignature(
  rawBody: string,
  headers: SvixHeaders,
  secret: string,
  now: Date = new Date(),
): { ok: boolean; reason?: string } {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: 'Missing svix-id, svix-timestamp or svix-signature header.' };
  }

  // Reject stale deliveries so a captured payload cannot be replayed later.
  const sentMs = Number(timestamp) * 1000;
  if (!Number.isFinite(sentMs)) return { ok: false, reason: 'Malformed svix-timestamp.' };
  if (Math.abs(now.getTime() - sentMs) > FIVE_MINUTES_MS) {
    return { ok: false, reason: 'Webhook timestamp is outside the five-minute tolerance.' };
  }

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');

  const provided = signature
    .split(' ')
    .map((part) => part.split(',', 2)[1])
    .filter((sig): sig is string => Boolean(sig));

  if (provided.some((sig) => safeEquals(sig, expected))) return { ok: true };
  return { ok: false, reason: 'Signature does not match.' };
}

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------

/**
 * Twilio signs with base64(HMAC-SHA1(authToken, url + sortedParamConcatenation)),
 * where the URL must be exactly the one Twilio requested. Behind a proxy or load
 * balancer the locally-observed URL is usually wrong, which is why the public
 * URL is configuration rather than something we infer.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string | undefined,
  authToken: string,
): { ok: boolean; reason?: string } {
  if (!signatureHeader) return { ok: false, reason: 'Missing X-Twilio-Signature header.' };

  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest('base64');
  return safeEquals(signatureHeader, expected)
    ? { ok: true }
    : { ok: false, reason: 'Signature does not match. Check that CRM_PUBLIC_URL matches the URL configured in Twilio.' };
}
