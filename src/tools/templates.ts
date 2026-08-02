import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { auditedTool, errorResult, jsonResult, readTool } from './helpers.js';
import { checkCopyTruthfulness } from '../core/compliance.js';
import { CopyGenerationError } from '../core/copygen.js';
import { contactVars, prepareMessage, templateVariables, unsubscribeUrl } from '../core/render.js';
import { findContact, getTemplate } from '../db/repo.js';
import { CHANNELS } from '../types.js';

export function registerTemplateTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'crm_create_template',
    {
      title: 'Create template',
      description:
        'Saves a message template. Use {{first_name}}-style placeholders. Copy is checked against the ' +
        'truthfulness rules before it is stored -- claims AI Bestie cannot back up are rejected here, not ' +
        'at send time.',
      inputSchema: {
        name: z.string().min(2),
        channel: z.enum(CHANNELS),
        subject: z.string().optional().describe('Email subject or push title'),
        body: z.string().min(1),
      },
    },
    auditedTool(ctx, 'crm_create_template', async (args) => {
      const check = checkCopyTruthfulness(`${args.subject ?? ''}\n${args.body}`);
      if (!check.ok) {
        return {
          result: errorResult('Template rejected: it makes claims AI Bestie cannot support.', {
            violations: check.violations,
          }),
          summary: `rejected template "${args.name}": ${check.violations.map((v) => v.rule).join(', ')}`,
        };
      }

      const variables = [...new Set([...templateVariables(args.body), ...templateVariables(args.subject ?? '')])];
      const { rows } = await ctx.db.query<{ id: string }>(
        `insert into crm.templates (channel, name, subject, body, variables)
         values ($1,$2,$3,$4,$5)
         on conflict (name) do update
           set channel = excluded.channel, subject = excluded.subject,
               body = excluded.body, variables = excluded.variables
         returning id`,
        [args.channel, args.name, args.subject ?? null, args.body, variables],
      );

      return {
        result: jsonResult({ id: rows[0]!.id, name: args.name, channel: args.channel, variables }),
        summary: `saved ${args.channel} template "${args.name}"`,
      };
    }),
  );

  server.registerTool(
    'crm_list_templates',
    {
      title: 'List templates',
      description: 'Lists saved templates.',
      inputSchema: {
        channel: z.enum(CHANNELS).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    readTool(async (args) => {
      const { rows } = await ctx.db.query(
        `select id, channel, name, subject, body, variables, created_at from crm.templates
         where ($1::text is null or channel = $1) order by created_at desc limit $2`,
        [args.channel ?? null, args.limit ?? 50],
      );
      return jsonResult({ count: rows.length, templates: rows });
    }),
  );

  server.registerTool(
    'crm_generate_copy',
    {
      title: 'Generate campaign copy',
      description:
        "Generates on-brand copy with Claude. Leads with Bestie's live video call (\"show her the problem, " +
        'she sees it and walks you through it") and the free unlimited chat hook, and stays inside the honest ' +
        'framing: free video/voice are daily-capped, chat is genuinely unlimited, and Bestie is not a ' +
        'licensed professional. Output is re-checked against those rules before it is returned.',
      inputSchema: {
        channel: z.enum(CHANNELS),
        goal: z.string().min(5).describe('What this message should achieve'),
        audience: z.string().optional().describe('Who is receiving it, e.g. "trial users on day 5"'),
        tone: z.string().optional(),
        variables: z.array(z.string()).optional().describe('Placeholders the copy may use, e.g. ["first_name"]'),
        variant_count: z.number().int().min(1).max(3).default(1),
        save_as: z.string().optional().describe('Save the result as a template with this name'),
      },
    },
    auditedTool(ctx, 'crm_generate_copy', async (args) => {
      if (!ctx.copy.available) {
        return {
          result: errorResult('ANTHROPIC_API_KEY is not configured, so copy cannot be generated.'),
          summary: 'copy engine unavailable',
        };
      }

      try {
        const result = await ctx.copy.generate({
          channel: args.channel,
          goal: args.goal,
          audience: args.audience,
          tone: args.tone,
          variables: args.variables,
          variantCount: args.variant_count ?? 1,
        });

        let savedId: string | null = null;
        if (args.save_as) {
          const variables = [...new Set([...templateVariables(result.body), ...templateVariables(result.subject ?? '')])];
          const { rows } = await ctx.db.query<{ id: string }>(
            `insert into crm.templates (channel, name, subject, body, variables)
             values ($1,$2,$3,$4,$5)
             on conflict (name) do update
               set subject = excluded.subject, body = excluded.body, variables = excluded.variables
             returning id`,
            [args.channel, args.save_as, result.subject ?? null, result.body, variables],
          );
          savedId = rows[0]!.id;
        }

        return {
          result: jsonResult({
            channel: args.channel,
            subject: result.subject,
            body: result.body,
            variants: result.variants,
            model: result.model,
            regenerated_for_compliance: result.regenerated,
            saved_template_id: savedId,
          }),
          summary: `generated ${args.channel} copy for "${args.goal.slice(0, 60)}"`,
        };
      } catch (err) {
        if (err instanceof CopyGenerationError) {
          return {
            result: errorResult(err.message, { violations: err.violations }),
            summary: `copy generation refused: ${err.message.slice(0, 120)}`,
          };
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    'crm_render_preview',
    {
      title: 'Render preview',
      description:
        'Renders a template for one specific contact, with the unsubscribe link and physical address (email) ' +
        'or STOP notice (SMS) attached exactly as a real send would. Sends nothing.',
      inputSchema: {
        template: z.string().optional().describe('Template name or id'),
        body: z.string().optional().describe('Inline body, if not using a saved template'),
        subject: z.string().optional(),
        channel: z.enum(CHANNELS).optional(),
        contact_id: z.string().uuid(),
      },
    },
    readTool(async (args) => {
      const contact = await findContact(ctx.db, { id: args.contact_id });
      if (!contact) return errorResult('No such contact.');

      let body = args.body;
      let subject = args.subject ?? null;
      let channel = args.channel;

      if (args.template) {
        const template = await getTemplate(ctx.db, args.template);
        if (!template) return errorResult(`No template named "${args.template}".`);
        body = template.body;
        subject = args.subject ?? template.subject;
        channel = template.channel;
      }

      if (!body) return errorResult('Provide either a saved `template` or an inline `body`.');
      if (!channel) return errorResult('Provide a `channel` when rendering an inline body.');

      const prepared = prepareMessage({
        channel,
        subject,
        body,
        vars: contactVars(contact),
        unsubscribeUrl: unsubscribeUrl(
          ctx.config.guardrails.unsubscribeBaseUrl,
          contact.id,
          ctx.config.bearerToken,
        ),
        physicalAddress: ctx.config.guardrails.senderPhysicalAddress,
      });

      return jsonResult({
        channel,
        subject: prepared.subject,
        body: prepared.body,
        character_count: prepared.body.length,
        missing_variables: prepared.missingVariables,
        compliance_issues: prepared.complianceIssues,
        truthfulness_violations: prepared.truthfulnessViolations,
        note: 'Preview only. Nothing was sent.',
      });
    }),
  );
}
