import type { Config } from '../config.js';
import type { ChannelAdapter, OutboundMessage, SendResult } from './types.js';
import { postJson } from './types.js';

/**
 * Expo push. Unlike email and SMS this works without a token for development
 * projects, so it is always "configured" -- an access token just raises limits.
 */
export class ExpoPushAdapter implements ChannelAdapter {
  readonly channel = 'push' as const;
  readonly configured = true;
  readonly providerName = 'expo';

  constructor(private readonly accessToken: string | undefined) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;

    try {
      const res = await postJson('https://exp.host/--/api/v2/push/send', {
        headers,
        body: JSON.stringify({
          to: message.to,
          title: message.subject ?? 'Bestie',
          body: message.body,
        }),
      });
      if (!res.ok) {
        return { status: 'failed', error: `expo ${res.status}: ${res.text.slice(0, 200)}` };
      }
      // Expo answers 200 with a per-ticket status, so a transport-level OK is
      // not the same as an accepted push.
      const ticket = (res.json as { data?: { status?: string; id?: string; message?: string } } | null)?.data;
      if (ticket?.status === 'error') {
        return { status: 'failed', error: ticket.message ?? 'expo rejected the push ticket' };
      }
      return { status: 'sent', providerId: ticket?.id };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function createPushAdapter(config: Config): ChannelAdapter {
  return new ExpoPushAdapter(config.expoAccessToken);
}
