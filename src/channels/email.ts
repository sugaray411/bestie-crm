import type { Config } from '../config.js';
import type { ChannelAdapter, OutboundMessage, SendResult } from './types.js';
import { postJson, UnconfiguredAdapter } from './types.js';

/**
 * Resend adapter. The unsubscribe link and physical address are added upstream
 * by core/compliance.ts before anything reaches here -- this layer only ships
 * bytes, so a provider swap can never drop a legal requirement.
 */
export class ResendEmailAdapter implements ChannelAdapter {
  readonly channel = 'email' as const;
  readonly configured = true;
  readonly providerName = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const res = await postJson('https://api.resend.com/emails', {
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject ?? '(no subject)',
          text: message.body,
        }),
      });
      if (!res.ok) {
        return { status: 'failed', error: `resend ${res.status}: ${res.text.slice(0, 200)}` };
      }
      const id = (res.json as { id?: string } | null)?.id;
      return { status: 'sent', providerId: id ?? undefined };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function createEmailAdapter(config: Config): ChannelAdapter {
  if (!config.resendApiKey) return new UnconfiguredAdapter('email', 'resend', 'RESEND_API_KEY');
  return new ResendEmailAdapter(config.resendApiKey, config.emailFrom);
}
