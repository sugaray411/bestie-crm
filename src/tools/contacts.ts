import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { auditedTool, errorResult, jsonResult, readTool } from './helpers.js';
import { validateImportBasis } from '../core/compliance.js';
import { maskEmail, maskPhone } from '../core/audit.js';
import {
  addSuppression,
  consentsFor,
  createContact,
  findContact,
  recordConsent,
  searchContacts,
  updateContact,
} from '../db/repo.js';
import { CHANNELS, CONSENT_BASES, LIFECYCLE_STAGES, type Contact } from '../types.js';

const ContactFields = {
  email: z.string().email().optional(),
  phone: z.string().min(5).optional(),
  push_token: z.string().optional(),
  name: z.string().optional(),
  source: z.string().optional(),
  locale: z.string().optional(),
  country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2, e.g. US, DE'),
  timezone: z.string().optional().describe('IANA timezone, e.g. Europe/Berlin. Used for quiet hours.'),
  tags: z.array(z.string()).optional(),
  lifecycle_stage: z.enum(LIFECYCLE_STAGES).optional(),
  rc_app_user_id: z.string().optional().describe('RevenueCat/Clerk id, for linking to subscription data'),
};

/** Tool output masks addresses; the CRM knows them, the transcript need not. */
export function publicContact(contact: Contact): Record<string, unknown> {
  return {
    id: contact.id,
    email: contact.email ? maskEmail(contact.email) : null,
    phone: contact.phone ? maskPhone(contact.phone) : null,
    has_push_token: Boolean(contact.push_token),
    name: contact.name,
    source: contact.source,
    locale: contact.locale,
    country: contact.country,
    timezone: contact.timezone,
    tags: contact.tags,
    lifecycle_stage: contact.lifecycle_stage,
    rc_app_user_id: contact.rc_app_user_id,
    created_at: contact.created_at,
  };
}

export function registerContactTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'crm_create_contact',
    {
      title: 'Create contact',
      description:
        'Creates a marketing contact. A contact needs at least one address (email, phone or push token). ' +
        'Creating a contact grants no permission to message it -- record consent separately.',
      inputSchema: {
        ...ContactFields,
        consent: z
          .object({
            channel: z.enum(CHANNELS),
            basis: z.enum(CONSENT_BASES),
            source: z.string().describe('Where the opt-in happened, e.g. "in-app settings toggle"'),
            ip: z.string().optional(),
          })
          .optional()
          .describe('Optional consent to record at the same time, if the contact just opted in.'),
      },
    },
    auditedTool(ctx, 'crm_create_contact', async (args) => {
      if (!args.email && !args.phone && !args.push_token) {
        return {
          result: errorResult('A contact needs at least one of: email, phone, push_token.'),
          summary: 'rejected: no address',
        };
      }
      const contact = await createContact(ctx.db, args);
      if (args.consent) {
        await recordConsent(ctx.db, {
          contact_id: contact.id,
          channel: args.consent.channel,
          status: 'granted',
          basis: args.consent.basis,
          source: args.consent.source,
          ip: args.consent.ip ?? null,
        });
      }
      return {
        result: jsonResult({
          contact: publicContact(contact),
          consent_recorded: args.consent?.channel ?? null,
        }),
        summary: `created contact ${contact.id}`,
      };
    }),
  );

  server.registerTool(
    'crm_update_contact',
    {
      title: 'Update contact',
      description: 'Updates contact attributes. Does not change consent -- use crm_record_consent.',
      inputSchema: {
        id: z.string().uuid(),
        ...ContactFields,
      },
    },
    auditedTool(ctx, 'crm_update_contact', async ({ id, ...fields }) => {
      const contact = await updateContact(ctx.db, id, fields);
      if (!contact) {
        return { result: errorResult(`No contact with id ${id}.`), summary: 'not found' };
      }
      return {
        result: jsonResult({ contact: publicContact(contact) }),
        summary: `updated contact ${id} (${Object.keys(fields).join(', ')})`,
      };
    }),
  );

  server.registerTool(
    'crm_get_contact',
    {
      title: 'Get contact',
      description: 'Fetches one contact by id, email, phone or RevenueCat id, including consent state.',
      inputSchema: {
        id: z.string().uuid().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        rc_app_user_id: z.string().optional(),
      },
    },
    readTool(async (args) => {
      const contact = await findContact(ctx.db, args);
      if (!contact) return errorResult('No matching contact.');
      const consents = await consentsFor(ctx.db, contact.id);
      return jsonResult({ contact: publicContact(contact), consents });
    }),
  );

  server.registerTool(
    'crm_search_contacts',
    {
      title: 'Search contacts',
      description: 'Searches contacts by free text, lifecycle stage or tag.',
      inputSchema: {
        q: z.string().optional(),
        lifecycle_stage: z.enum(LIFECYCLE_STAGES).optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(25),
      },
    },
    readTool(async (args) => {
      const contacts = await searchContacts(ctx.db, { ...args, limit: args.limit ?? 25 });
      return jsonResult({ count: contacts.length, contacts: contacts.map(publicContact) });
    }),
  );

  server.registerTool(
    'crm_import_contacts',
    {
      title: 'Import contacts',
      description:
        'Bulk-imports contacts that have already consented. Requires a lawful basis and an attestation ' +
        'of how consent was collected. Purchased, rented, scraped or appended lists are rejected outright.',
      inputSchema: {
        basis: z.enum(CONSENT_BASES),
        source: z.string().min(3).describe('Concrete origin, e.g. "bestie.app newsletter form"'),
        attestation: z
          .string()
          .min(12)
          .describe('How and when these people consented, in your own words. Required.'),
        channel: z.enum(CHANNELS).default('email'),
        contacts: z
          .array(
            z.object({
              email: z.string().email().optional(),
              phone: z.string().optional(),
              name: z.string().optional(),
              country: z.string().length(2).optional(),
              timezone: z.string().optional(),
              tags: z.array(z.string()).optional(),
            }),
          )
          .min(1)
          .max(5000),
      },
    },
    auditedTool(ctx, 'crm_import_contacts', async (args) => {
      const verdict = validateImportBasis({
        basis: args.basis,
        source: args.source,
        contactCount: args.contacts.length,
        attestation: args.attestation,
      });

      if (!verdict.ok) {
        return {
          result: errorResult('Import rejected.', { reasons: verdict.reasons }),
          summary: `rejected import of ${args.contacts.length}: ${verdict.reasons[0] ?? ''}`,
        };
      }

      if (verdict.needsHumanReview) {
        return {
          result: jsonResult({
            status: 'needs_human_review',
            reasons: verdict.reasons,
            contact_count: args.contacts.length,
            note: 'Nothing was imported. A human must review this list before it enters the CRM.',
          }),
          summary: `flagged import of ${args.contacts.length} for human review`,
        };
      }

      const channel = args.channel ?? 'email';
      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const row of args.contacts) {
        if (!row.email && !row.phone) {
          skipped += 1;
          continue;
        }
        try {
          const existing = await findContact(ctx.db, {
            email: row.email ?? undefined,
            phone: row.phone ?? undefined,
          });
          const contact = existing ?? (await createContact(ctx.db, { ...row, source: args.source }));
          await recordConsent(ctx.db, {
            contact_id: contact.id,
            channel,
            status: 'granted',
            basis: args.basis,
            source: args.source,
          });
          imported += 1;
        } catch (err) {
          skipped += 1;
          if (errors.length < 5) errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      return {
        result: jsonResult({
          status: 'imported',
          imported,
          skipped,
          channel,
          basis: args.basis,
          errors,
        }),
        summary: `imported ${imported}/${args.contacts.length} on basis ${args.basis} from ${args.source}`,
      };
    }),
  );

  server.registerTool(
    'crm_export_contact',
    {
      title: 'Export contact data (GDPR/CCPA)',
      description:
        'Returns everything the CRM holds about one contact -- profile, consent history, messages and ' +
        'events -- for a subject access request. Addresses are unmasked here because that is the point.',
      inputSchema: {
        id: z.string().uuid().optional(),
        email: z.string().email().optional(),
      },
    },
    auditedTool(ctx, 'crm_export_contact', async (args) => {
      const contact = await findContact(ctx.db, args);
      if (!contact) return { result: errorResult('No matching contact.'), summary: 'not found' };

      const [consents, messages, events] = await Promise.all([
        consentsFor(ctx.db, contact.id),
        ctx.db.query(
          `select id, campaign_id, channel, status, sent_at from crm.messages
           where contact_id = $1 order by sent_at desc limit 500`,
          [contact.id],
        ),
        ctx.db.query(
          `select id, type, value, meta, occurred_at from crm.events
           where contact_id = $1 order by occurred_at desc limit 500`,
          [contact.id],
        ),
      ]);

      return {
        result: jsonResult({
          contact,
          consents,
          messages: messages.rows,
          events: events.rows,
          exported_at: ctx.now().toISOString(),
        }),
        summary: `exported subject data for contact ${contact.id}`,
      };
    }),
  );

  server.registerTool(
    'crm_delete_contact',
    {
      title: 'Delete contact (GDPR erasure)',
      description:
        'Erases a contact and their messages and events. The addresses are added to the suppression list ' +
        'first, so a future import cannot resurrect someone who asked to be forgotten.',
      inputSchema: {
        id: z.string().uuid().optional(),
        email: z.string().email().optional(),
        confirm: z.boolean().default(false).describe('Must be true. Erasure cannot be undone.'),
      },
    },
    auditedTool(ctx, 'crm_delete_contact', async (args) => {
      const contact = await findContact(ctx.db, args);
      if (!contact) return { result: errorResult('No matching contact.'), summary: 'not found' };
      if (!args.confirm) {
        return {
          result: errorResult('Set confirm=true to erase. This deletes the contact, their messages and their events.', {
            contact: publicContact(contact),
          }),
          summary: 'erasure not confirmed',
        };
      }

      // Suppress before deleting: after the row is gone we no longer know what
      // to suppress, and "deleted" must not mean "eligible for re-import".
      if (contact.email) await addSuppression(ctx.db, { channel: 'email', value: contact.email, reason: 'manual' });
      if (contact.phone) await addSuppression(ctx.db, { channel: 'sms', value: contact.phone, reason: 'manual' });
      if (contact.push_token) {
        await addSuppression(ctx.db, { channel: 'push', value: contact.push_token, reason: 'manual' });
      }

      // messages/events/consents cascade from the contacts FK.
      await ctx.db.query('delete from crm.contacts where id = $1', [contact.id]);

      return {
        result: jsonResult({
          status: 'erased',
          contact_id: contact.id,
          suppression_added: true,
          note: 'Addresses were added to the suppression list so the contact cannot be re-imported and messaged.',
        }),
        summary: `erased contact ${contact.id} and suppressed their addresses`,
      };
    }),
  );
}
