import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { auditedTool, errorResult, jsonResult, readTool } from './helpers.js';
import { resolveConsent, requiresExplicitOptIn } from '../core/consentGate.js';
import { isStopKeyword } from '../core/compliance.js';
import { verifyUnsubscribeToken } from '../core/render.js';
import {
  addSuppression,
  consentsFor,
  findContact,
  isSuppressed,
  recordConsent,
} from '../db/repo.js';
import { CHANNELS, CONSENT_BASES, SUPPRESSION_REASONS } from '../types.js';

/**
 * Consent and suppression: the gate every send passes through. These tools are
 * the only way consent state changes, so the audit log is a complete record of
 * who granted what, when, and on what basis.
 */
export function registerConsentTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'crm_record_consent',
    {
      title: 'Record consent',
      description:
        'Records a consent grant for one channel. Consent history is append-only and the latest record wins. ' +
        'The source must describe a real opt-in action -- this is the evidence if the grant is ever challenged.',
      inputSchema: {
        contact_id: z.string().uuid(),
        channel: z.enum(CHANNELS),
        basis: z.enum(CONSENT_BASES),
        source: z.string().min(3).describe('e.g. "signup form checkbox", "in-app notification prompt"'),
        ip: z.string().optional(),
      },
    },
    auditedTool(ctx, 'crm_record_consent', async (args) => {
      const contact = await findContact(ctx.db, { id: args.contact_id });
      if (!contact) return { result: errorResult('No such contact.'), summary: 'not found' };

      const warnings: string[] = [];
      if (requiresExplicitOptIn(contact.country) && args.basis !== 'opt_in') {
        warnings.push(
          `${contact.country} requires an explicit opt-in. Basis "${args.basis}" is recorded but sends to ` +
            'this contact will be skipped until a direct opt-in is on file.',
        );
      }

      await recordConsent(ctx.db, { ...args, status: 'granted' });
      return {
        result: jsonResult({
          status: 'granted',
          contact_id: args.contact_id,
          channel: args.channel,
          basis: args.basis,
          warnings,
        }),
        summary: `consent granted ${args.channel}/${args.basis} for ${args.contact_id}`,
      };
    }),
  );

  server.registerTool(
    'crm_revoke_consent',
    {
      title: 'Revoke consent',
      description:
        'Revokes consent for a channel and adds the address to the suppression list. Use this for any ' +
        'opt-out that did not arrive through the unsubscribe link.',
      inputSchema: {
        contact_id: z.string().uuid(),
        channel: z.enum(CHANNELS),
        reason: z.enum(SUPPRESSION_REASONS).default('unsubscribe'),
      },
    },
    auditedTool(ctx, 'crm_revoke_consent', async (args) => {
      const contact = await findContact(ctx.db, { id: args.contact_id });
      if (!contact) return { result: errorResult('No such contact.'), summary: 'not found' };

      await recordConsent(ctx.db, {
        contact_id: args.contact_id,
        channel: args.channel,
        status: 'revoked',
        basis: 'opt_in',
        source: `revoked:${args.reason ?? 'unsubscribe'}`,
      });

      const address =
        args.channel === 'email' ? contact.email : args.channel === 'sms' ? contact.phone : contact.push_token;
      if (address) {
        await addSuppression(ctx.db, {
          channel: args.channel,
          value: address,
          reason: args.reason ?? 'unsubscribe',
        });
      }

      return {
        result: jsonResult({
          status: 'revoked',
          contact_id: args.contact_id,
          channel: args.channel,
          suppressed: Boolean(address),
        }),
        summary: `consent revoked ${args.channel} for ${args.contact_id}`,
      };
    }),
  );

  server.registerTool(
    'crm_handle_unsubscribe',
    {
      title: 'Handle unsubscribe / STOP',
      description:
        'Processes an inbound opt-out: an unsubscribe link click, an email unsubscribe, or an SMS STOP ' +
        'keyword. Revokes consent and suppresses the address immediately, which is what TCPA requires.',
      inputSchema: {
        channel: z.enum(CHANNELS),
        contact_id: z.string().uuid().optional(),
        address: z.string().optional().describe('Email or phone number, if the contact id is unknown'),
        token: z.string().optional().describe('Token from the unsubscribe link, when it came from one'),
        inbound_text: z.string().optional().describe('Raw inbound SMS body, e.g. "STOP"'),
      },
    },
    auditedTool(ctx, 'crm_handle_unsubscribe', async (args) => {
      // An inbound SMS is only an opt-out if it actually says so. Suppressing on
      // any inbound message would silently kill legitimate conversations.
      if (args.inbound_text !== undefined && !isStopKeyword(args.inbound_text)) {
        return {
          result: jsonResult({
            status: 'not_an_opt_out',
            note: `"${args.inbound_text.slice(0, 40)}" is not a recognised opt-out keyword. Nothing changed.`,
          }),
          summary: 'inbound text was not an opt-out keyword',
        };
      }

      const contact = await findContact(ctx.db, {
        id: args.contact_id,
        email: args.channel === 'email' ? args.address : undefined,
        phone: args.channel === 'sms' ? args.address : undefined,
      });

      if (args.token && args.contact_id) {
        if (!verifyUnsubscribeToken(args.contact_id, args.token, ctx.config.bearerToken)) {
          return {
            result: errorResult('Unsubscribe token does not match the contact id.'),
            summary: 'invalid unsubscribe token',
          };
        }
      }

      // Suppress the address even when no contact row matches: a bounce or a
      // STOP from an unknown number still means "never message this".
      const address = args.address ?? (args.channel === 'email' ? contact?.email : contact?.phone) ?? null;
      if (address) {
        await addSuppression(ctx.db, { channel: args.channel, value: address, reason: 'unsubscribe' });
      }
      if (contact) {
        await recordConsent(ctx.db, {
          contact_id: contact.id,
          channel: args.channel,
          status: 'revoked',
          basis: 'opt_in',
          source: args.inbound_text ? 'inbound_stop' : 'unsubscribe_link',
        });
      }

      return {
        result: jsonResult({
          status: 'opted_out',
          channel: args.channel,
          contact_found: Boolean(contact),
          suppressed: Boolean(address),
        }),
        summary: `opt-out processed for ${args.channel}`,
      };
    }),
  );

  server.registerTool(
    'crm_check_consent',
    {
      title: 'Check consent',
      description:
        'Resolves current consent for a contact and channel, including whether their country requires an ' +
        'explicit opt-in and whether their address is suppressed. This is what the send gate sees.',
      inputSchema: {
        contact_id: z.string().uuid(),
        channel: z.enum(CHANNELS),
      },
    },
    readTool(async (args) => {
      const contact = await findContact(ctx.db, { id: args.contact_id });
      if (!contact) return errorResult('No such contact.');

      const consents = await consentsFor(ctx.db, contact.id);
      const resolved = resolveConsent(consents, args.channel);
      const address =
        args.channel === 'email' ? contact.email : args.channel === 'sms' ? contact.phone : contact.push_token;
      const suppressed = address ? await isSuppressed(ctx.db, args.channel, address) : false;
      const needsOptIn = requiresExplicitOptIn(contact.country);

      const sendable =
        resolved.status === 'granted' &&
        !suppressed &&
        Boolean(address) &&
        (!needsOptIn || resolved.basis === 'opt_in');

      return jsonResult({
        contact_id: contact.id,
        channel: args.channel,
        consent: resolved,
        suppressed,
        has_address: Boolean(address),
        region_requires_explicit_opt_in: needsOptIn,
        sendable,
        history_count: consents.filter((c) => c.channel === args.channel).length,
      });
    }),
  );

  server.registerTool(
    'crm_add_suppression',
    {
      title: 'Add to suppression list',
      description:
        'Adds an address to the suppression list. Suppression is absolute: a suppressed address is never ' +
        'messaged again, whatever consent says.',
      inputSchema: {
        channel: z.enum(CHANNELS),
        value: z.string().min(3).describe('Email address, phone number or push token'),
        reason: z.enum(SUPPRESSION_REASONS),
      },
    },
    auditedTool(ctx, 'crm_add_suppression', async (args) => {
      await addSuppression(ctx.db, args);
      return {
        result: jsonResult({ status: 'suppressed', channel: args.channel, reason: args.reason }),
        summary: `suppressed a ${args.channel} address (${args.reason})`,
      };
    }),
  );

  server.registerTool(
    'crm_is_suppressed',
    {
      title: 'Check suppression',
      description: 'Checks whether an address is on the suppression list.',
      inputSchema: {
        channel: z.enum(CHANNELS),
        value: z.string().min(3),
      },
    },
    readTool(async (args) => {
      const suppressed = await isSuppressed(ctx.db, args.channel, args.value);
      return jsonResult({ channel: args.channel, suppressed });
    }),
  );
}
