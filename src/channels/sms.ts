import type { Config } from '../config.js';
import type { ChannelAdapter, OutboundMessage, SendResult } from './types.js';
import { UnconfiguredAdapter } from './types.js';

/**
 * Twilio adapter. The "Reply STOP to opt out" notice is appended upstream by
 * core/compliance.ts; Twilio also honours STOP itself, and inbound STOP is fed
 * back through crm_handle_unsubscribe so our own suppression list agrees.
 */
export class TwilioSmsAdapter implements ChannelAdapter {
  readonly channel = 'sms' as const;
  readonly configured = true;
  readonly providerName = 'twilio';

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: message.to, From: this.from, Body: message.body }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        return { status: 'failed', error: `twilio ${res.status}: ${text.slice(0, 200)}` };
      }
      const sid = (JSON.parse(text) as { sid?: string }).sid;
      return { status: 'sent', providerId: sid ?? undefined };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createSmsAdapter(config: Config): ChannelAdapter {
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFromNumber) {
    return new UnconfiguredAdapter('sms', 'twilio', 'TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER');
  }
  return new TwilioSmsAdapter(config.twilioAccountSid, config.twilioAuthToken, config.twilioFromNumber);
}
