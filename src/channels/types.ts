import type { Channel } from '../types.js';

export interface OutboundMessage {
  to: string;
  subject?: string | undefined;
  body: string;
  /** Per-recipient unsubscribe URL, for List-Unsubscribe headers on email. */
  unsubscribeUrl?: string | undefined;
}

export interface SendResult {
  status: 'sent' | 'failed';
  providerId?: string;
  error?: string;
}

/**
 * One interface per channel so providers are swappable (Resend -> Postmark/SES,
 * Twilio -> anything) without touching the consent gate that wraps them.
 */
export interface ChannelAdapter {
  readonly channel: Channel;
  /** False when credentials are missing; the gate reports this instead of failing mid-send. */
  readonly configured: boolean;
  readonly providerName: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

export class UnconfiguredAdapter implements ChannelAdapter {
  readonly configured = false;
  constructor(
    readonly channel: Channel,
    readonly providerName: string,
    private readonly missing: string,
  ) {}

  async send(): Promise<SendResult> {
    return {
      status: 'failed',
      error: `${this.channel} channel is not configured (missing ${this.missing}). Dry runs still work.`,
    };
  }
}

/** Shared fetch wrapper: bounded timeout, no retries on 4xx. */
export async function postJson(
  url: string,
  init: { headers: Record<string, string>; body: string; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}
