import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { auditedTool, errorResult, jsonResult } from './helpers.js';
import { buildSendPlan, executeSendPlan } from '../core/sendPipeline.js';
import { findContact, getTemplate } from '../db/repo.js';
import type { Channel } from '../types.js';

/**
 * Single-contact sends. They run through the same pipeline as a campaign, so a
 * one-off message cannot become the hole in the gate: consent, suppression,
 * quiet hours, frequency cap and rate limit all still apply.
 */
function registerSingleSend(server: McpServer, ctx: ServerContext, channel: Channel): void {
  const toolName = `crm_send_${channel}` as const;
  const quiet = channel === 'sms' || channel === 'push';

  server.registerTool(
    toolName,
    {
      title: `Send a single ${channel}`,
      description:
        `Sends one ${channel} message to one contact, through the full consent gate. Defaults to a dry run; ` +
        `a real send needs dry_run=false and confirm=true.` +
        (quiet ? ' Respects quiet hours (09:00-20:00) in the contact\'s timezone.' : ''),
      inputSchema: {
        contact_id: z.string().uuid(),
        template: z.string().optional().describe('Template name or id'),
        subject: z.string().optional().describe(channel === 'email' ? 'Email subject' : 'Push title (ignored for SMS)'),
        body: z.string().optional().describe('Inline body, if not using a template'),
        dry_run: z.boolean().default(true),
        confirm: z.boolean().default(false),
      },
    },
    auditedTool(ctx, toolName, async (args) => {
      const contact = await findContact(ctx.db, { id: args.contact_id });
      if (!contact) return { result: errorResult('No such contact.'), summary: 'not found' };

      let body = args.body;
      let subject = args.subject ?? null;
      if (args.template) {
        const template = await getTemplate(ctx.db, args.template);
        if (!template) return { result: errorResult(`No template named "${args.template}".`), summary: 'missing template' };
        if (template.channel !== channel) {
          return {
            result: errorResult(`Template "${template.name}" is a ${template.channel} template, not ${channel}.`),
            summary: 'channel mismatch',
          };
        }
        body = template.body;
        subject = args.subject ?? template.subject;
      }
      if (!body) return { result: errorResult('Provide either a `template` or an inline `body`.'), summary: 'no body' };

      const dryRun = args.dry_run !== false;
      const plan = await buildSendPlan(ctx, {
        channel,
        contacts: [contact],
        subject,
        body,
        dryRun,
      });
      const entry = plan.plan[0]!;

      if (dryRun) {
        return {
          result: jsonResult({
            status: entry.allowed ? 'would_send' : 'would_skip',
            ...entry,
            compliance_issues: plan.compliance_issues,
            note: 'Dry run. Nothing was sent. Re-run with dry_run=false and confirm=true to send.',
          }),
          summary: `dry run ${channel} to ${contact.id}: ${entry.allowed ? 'sendable' : entry.skip_reason}`,
        };
      }

      if (!args.confirm) {
        return {
          result: errorResult('A real send requires confirm=true as well as dry_run=false. Nothing was sent.'),
          summary: 'send not confirmed',
        };
      }

      if (!entry.allowed) {
        // Still recorded: "we deliberately did not send, and why" is the record
        // that matters later.
        await executeSendPlan(ctx, { channel, contacts: [contact], subject, body, dryRun: false, plan });
        return {
          result: jsonResult({
            status: 'skipped',
            skip_reason: entry.skip_reason,
            detail: entry.detail,
            note: 'The gate blocked this message. The skip is recorded in crm.messages.',
          }),
          summary: `${channel} skipped for ${contact.id}: ${entry.skip_reason}`,
        };
      }

      if (plan.compliance_issues.length > 0) {
        return {
          result: errorResult('Send blocked by compliance issues in the rendered message.', {
            compliance_issues: plan.compliance_issues,
          }),
          summary: `blocked: ${plan.compliance_issues.join('; ').slice(0, 150)}`,
        };
      }

      if (!plan.budget.allowed) {
        return {
          result: errorResult(plan.budget.reason ?? 'Daily spend ceiling reached.'),
          summary: 'budget ceiling reached',
        };
      }

      const adapter = ctx.adapters[channel];
      if (!adapter.configured) {
        return {
          result: errorResult(`The ${channel} channel is not configured, so nothing can be sent.`),
          summary: `channel ${channel} unconfigured`,
        };
      }

      const result = await executeSendPlan(ctx, {
        channel,
        contacts: [contact],
        subject,
        body,
        dryRun: false,
        plan,
      });

      return {
        result: jsonResult({
          status: result.sent > 0 ? 'sent' : 'failed',
          ...result,
        }),
        summary: `${channel} to ${contact.id}: ${result.sent > 0 ? 'sent' : `failed (${result.errors[0] ?? 'unknown'})`}`,
      };
    }),
  );
}

export function registerSendTools(server: McpServer, ctx: ServerContext): void {
  registerSingleSend(server, ctx, 'email');
  registerSingleSend(server, ctx, 'sms');
  registerSingleSend(server, ctx, 'push');
}
