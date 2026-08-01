import type { Request, Response } from 'express';
import { Router } from 'express';
import type { ServerContext } from '../context.js';
import { verifyUnsubscribeToken } from '../core/render.js';
import { writeAudit } from '../core/audit.js';
import { addSuppression, findContact, recordConsent } from '../db/repo.js';

/**
 * The public unsubscribe endpoint. Without this, every email we send carries a
 * link to nowhere -- which is a CAN-SPAM violation, not a missing nice-to-have.
 *
 * These routes are deliberately UNAUTHENTICATED: the recipient of an email has
 * no bearer token. The per-contact HMAC in the link is what authorizes the
 * action, which is why it must be verified before anything is written.
 */

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; margin-bottom: .5rem; }
  p { color: #555; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } p { color: #aaa; } }
  button { font: inherit; padding: .7rem 1.4rem; border-radius: .5rem; border: 0;
           background: #b4562f; color: #fff; cursor: pointer; }
  .muted { font-size: .85rem; margin-top: 2rem; }
`;

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;

export function unsubscribeRouter(ctx: ServerContext): Router {
  const router = Router();

  /**
   * Confirmation page. This is a GET, so it must not change anything: mail
   * clients and security scanners prefetch links, and an unsubscribe that fires
   * on prefetch silently opts people out who never clicked.
   */
  router.get('/u/:contactId', (req: Request, res: Response) => {
    const contactId = String(req.params.contactId ?? '');
    const token = typeof req.query.t === 'string' ? req.query.t : '';

    if (!contactId || !verifyUnsubscribeToken(contactId, token, ctx.config.bearerToken)) {
      res.status(400).type('html').send(
        page(
          'Link not valid',
          '<h1>This unsubscribe link is not valid</h1>' +
            '<p>It may have been altered in transit. Reply to any message from us and we will remove you by hand.</p>',
        ),
      );
      return;
    }

    res.type('html').send(
      page(
        'Unsubscribe',
        `<h1>Unsubscribe from Bestie emails?</h1>
         <p>You will stop receiving marketing email from us. Your account and your chats are unaffected.</p>
         <form method="POST" action="/u/${encodeURIComponent(contactId)}?t=${encodeURIComponent(token)}">
           <button type="submit">Unsubscribe me</button>
         </form>
         <p class="muted">${escapeHtml(ctx.config.guardrails.senderPhysicalAddress)}</p>`,
      ),
    );
  });

  /**
   * Performs the unsubscribe. Serves both the button on the page above and
   * RFC 8058 one-click, which Gmail and Yahoo require of bulk senders -- their
   * clients POST here directly with `List-Unsubscribe=One-Click`.
   */
  router.post('/u/:contactId', (req: Request, res: Response) => {
    void (async () => {
      const contactId = String(req.params.contactId ?? '');
      const token =
        (typeof req.query.t === 'string' ? req.query.t : '') ||
        (typeof (req.body as Record<string, unknown> | undefined)?.t === 'string'
          ? String((req.body as Record<string, string>).t)
          : '');

      if (!contactId || !verifyUnsubscribeToken(contactId, token, ctx.config.bearerToken)) {
        res.status(400).type('html').send(page('Link not valid', '<h1>This unsubscribe link is not valid</h1>'));
        return;
      }

      const oneClick = String((req.body as Record<string, unknown> | undefined)?.['List-Unsubscribe'] ?? '') === 'One-Click';

      try {
        const contact = await findContact(ctx.db, { id: contactId });
        if (contact) {
          await recordConsent(ctx.db, {
            contact_id: contact.id,
            channel: 'email',
            status: 'revoked',
            basis: 'opt_in',
            source: oneClick ? 'list_unsubscribe_one_click' : 'unsubscribe_page',
          });
          if (contact.email) {
            await addSuppression(ctx.db, { channel: 'email', value: contact.email, reason: 'unsubscribe' });
          }
        }

        await writeAudit(ctx.db, {
          actor: 'public-unsubscribe',
          tool: 'unsubscribe_endpoint',
          args: { contact_id: contactId, one_click: oneClick },
          resultSummary: contact ? `unsubscribed contact ${contact.id}` : 'valid token but no such contact',
        });

        // One-click clients want a bare 200, not a web page.
        if (oneClick) {
          res.status(200).type('text/plain').send('OK');
          return;
        }

        res.type('html').send(
          page(
            'Unsubscribed',
            '<h1>Done — you are unsubscribed</h1>' +
              '<p>You will not receive marketing email from Bestie again. Chatting with her is still free and unlimited.</p>' +
              `<p class="muted">${escapeHtml(ctx.config.guardrails.senderPhysicalAddress)}</p>`,
          ),
        );
      } catch (err) {
        process.stderr.write(
          `[crm] unsubscribe failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        res.status(500).type('html').send(
          page(
            'Something went wrong',
            '<h1>We could not process that just now</h1><p>Please try again, or reply to any message from us.</p>',
          ),
        );
      }
    })();
  });

  return router;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
