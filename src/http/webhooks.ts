import type { Request, Response } from 'express';
import { Router } from 'express';
import type { ServerContext } from '../context.js';
import { verifySvixSignature, verifyTwilioSignature } from '../core/webhookAuth.js';
import { isStopKeyword } from '../core/compliance.js';
import { writeAudit } from '../core/audit.js';
import {
  addSuppression,
  advanceMessageStatus,
  findContact,
  markMessageFailed,
  recordConsent,
  type ProgressionStatus,
} from '../db/repo.js';

/**
 * Inbound provider webhooks. These close two loops the CRM cannot close on its
 * own:
 *
 *  - Deliverability: bounces and spam complaints must reach the suppression
 *    list, or we keep mailing addresses that are damaging the sending domain.
 *  - Truthful metrics: without delivery/open/click events every message stays
 *    at "sent" forever and crm_campaign_metrics reports a 0% open rate.
 *
 * Both routes are public and authenticated by provider signature, not by our
 * bearer token -- see core/webhookAuth.ts.
 */

/** Express request with the raw body captured for signature verification. */
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

interface ResendEvent {
  type?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { message?: string; type?: string };
  };
}

const RESEND_PROGRESSION: Record<string, ProgressionStatus> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
};

export function webhookRouter(ctx: ServerContext): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Resend: delivery lifecycle + bounces + complaints
  // -------------------------------------------------------------------------
  router.post('/webhooks/resend', (req: RawBodyRequest, res: Response) => {
    void (async () => {
      const secret = ctx.config.resendWebhookSecret;
      if (!secret) {
        res.status(503).json({ error: 'RESEND_WEBHOOK_SECRET is not configured.' });
        return;
      }

      const raw = req.rawBody?.toString('utf8') ?? '';
      const verdict = verifySvixSignature(
        raw,
        {
          id: req.header('svix-id'),
          timestamp: req.header('svix-timestamp'),
          signature: req.header('svix-signature'),
        },
        secret,
        ctx.now(),
      );
      if (!verdict.ok) {
        res.status(401).json({ error: verdict.reason ?? 'Invalid signature.' });
        return;
      }

      try {
        const event = req.body as ResendEvent;
        const type = event.type ?? '';
        const providerId = event.data?.email_id;
        const recipients = Array.isArray(event.data?.to)
          ? event.data.to
          : event.data?.to
            ? [event.data.to]
            : [];

        let summary = `ignored ${type}`;

        const progression = RESEND_PROGRESSION[type];
        if (progression && providerId) {
          const moved = await advanceMessageStatus(ctx.db, providerId, progression);
          summary = moved ? `message -> ${progression}` : `${progression} ignored (status already ahead)`;
        } else if (type === 'email.bounced') {
          if (providerId) {
            await markMessageFailed(ctx.db, providerId, 'bounced', event.data?.bounce?.message ?? 'bounced');
          }
          // Suppress regardless of whether we can match the message row: a bounce
          // is about the address, and losing it is how a sending domain rots.
          for (const address of recipients) {
            await addSuppression(ctx.db, { channel: 'email', value: address, reason: 'bounce' });
          }
          summary = `bounce suppressed ${recipients.length} address(es)`;
        } else if (type === 'email.complained') {
          for (const address of recipients) {
            await addSuppression(ctx.db, { channel: 'email', value: address, reason: 'complaint' });
            // A spam complaint is an opt-out in the strongest terms available.
            const contact = await findContact(ctx.db, { email: address });
            if (contact) {
              await recordConsent(ctx.db, {
                contact_id: contact.id,
                channel: 'email',
                status: 'revoked',
                basis: 'opt_in',
                source: 'spam_complaint',
              });
            }
          }
          summary = `complaint suppressed ${recipients.length} address(es)`;
        }

        await writeAudit(ctx.db, {
          actor: 'resend-webhook',
          tool: 'webhook_resend',
          args: { type, email_id: providerId },
          resultSummary: summary,
        });

        res.status(200).json({ received: true });
      } catch (err) {
        process.stderr.write(
          `[crm] resend webhook failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        // 500 asks Resend to retry; the handler is idempotent, so that is safe.
        res.status(500).json({ error: 'processing failed' });
      }
    })();
  });

  // -------------------------------------------------------------------------
  // Twilio: inbound SMS, which is how STOP reaches our suppression list
  // -------------------------------------------------------------------------
  router.post('/webhooks/twilio', (req: Request, res: Response) => {
    void (async () => {
      const authToken = ctx.config.twilioAuthToken;
      if (!authToken) {
        res.status(503).json({ error: 'TWILIO_AUTH_TOKEN is not configured.' });
        return;
      }

      const publicUrl = ctx.config.publicUrl;
      if (!publicUrl) {
        res.status(503).json({ error: 'CRM_PUBLIC_URL must be set to verify Twilio signatures.' });
        return;
      }

      const params = Object.fromEntries(
        Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
      const verdict = verifyTwilioSignature(
        `${publicUrl.replace(/\/+$/, '')}/webhooks/twilio`,
        params,
        req.header('x-twilio-signature'),
        authToken,
      );
      if (!verdict.ok) {
        res.status(401).json({ error: verdict.reason ?? 'Invalid signature.' });
        return;
      }

      try {
        const from = params.From ?? '';
        const body = params.Body ?? '';

        // Only an actual opt-out keyword opts anyone out. Suppressing on any
        // inbound message would silently kill legitimate replies.
        if (!isStopKeyword(body)) {
          await writeAudit(ctx.db, {
            actor: 'twilio-webhook',
            tool: 'webhook_twilio',
            args: { from, body },
            resultSummary: 'inbound sms was not an opt-out keyword',
          });
          res.status(200).type('text/xml').send('<Response></Response>');
          return;
        }

        if (from) {
          await addSuppression(ctx.db, { channel: 'sms', value: from, reason: 'unsubscribe' });
          const contact = await findContact(ctx.db, { phone: from });
          if (contact) {
            await recordConsent(ctx.db, {
              contact_id: contact.id,
              channel: 'sms',
              status: 'revoked',
              basis: 'opt_in',
              source: 'inbound_stop',
            });
          }
        }

        await writeAudit(ctx.db, {
          actor: 'twilio-webhook',
          tool: 'webhook_twilio',
          args: { from, body },
          resultSummary: 'STOP processed: consent revoked and number suppressed',
        });

        // Twilio auto-replies to STOP itself; an empty TwiML response avoids
        // sending a second message to someone who just asked us to stop.
        res.status(200).type('text/xml').send('<Response></Response>');
      } catch (err) {
        process.stderr.write(
          `[crm] twilio webhook failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        res.status(500).json({ error: 'processing failed' });
      }
    })();
  });

  return router;
}
