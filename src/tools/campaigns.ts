import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { auditedTool, errorResult, jsonResult, readTool } from './helpers.js';
import { approvalToken, buildSendPlan, executeSendPlan, verifyApprovalToken } from '../core/sendPipeline.js';
import { detectGuardrailOverride } from '../core/compliance.js';
import { segmentQuery } from '../core/segmentAst.js';
import { getCampaign, getSegment, getTemplate, setCampaignStatus } from '../db/repo.js';
import type { Contact } from '../types.js';

/** Hard ceiling on one call, independent of the approval threshold. */
const MAX_RECIPIENTS_PER_CALL = 5000;

export function registerCampaignTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'crm_create_campaign',
    {
      title: 'Create campaign',
      description:
        'Creates a campaign binding a template to a segment. Creating a campaign sends nothing; it starts ' +
        'as a draft with dry_run on.',
      inputSchema: {
        name: z.string().min(2),
        template: z.string().describe('Template name or id'),
        segment: z.string().describe('Segment name or id'),
        scheduled_at: z.string().datetime().optional().describe('ISO 8601. Informational -- sending is triggered explicitly.'),
        created_by: z.string().optional(),
      },
    },
    auditedTool(ctx, 'crm_create_campaign', async (args) => {
      const template = await getTemplate(ctx.db, args.template);
      if (!template) return { result: errorResult(`No template named "${args.template}".`), summary: 'missing template' };
      const segment = await getSegment(ctx.db, args.segment);
      if (!segment) return { result: errorResult(`No segment named "${args.segment}".`), summary: 'missing segment' };

      const { rows } = await ctx.db.query<{ id: string }>(
        `insert into crm.campaigns (name, channel, template_id, segment_id, status, scheduled_at, dry_run, created_by)
         values ($1,$2,$3,$4,$5,$6,true,$7)
         on conflict (name) do update
           set template_id = excluded.template_id, segment_id = excluded.segment_id,
               channel = excluded.channel, scheduled_at = excluded.scheduled_at
         returning id`,
        [
          args.name,
          template.channel,
          template.id,
          segment.id,
          args.scheduled_at ? 'scheduled' : 'draft',
          args.scheduled_at ?? null,
          args.created_by ?? ctx.config.actor,
        ],
      );

      return {
        result: jsonResult({
          id: rows[0]!.id,
          name: args.name,
          channel: template.channel,
          template: template.name,
          segment: segment.name,
          status: args.scheduled_at ? 'scheduled' : 'draft',
          dry_run: true,
          note: 'Run crm_send_campaign to see the dry-run plan before anything is sent.',
        }),
        summary: `created campaign "${args.name}" (${template.channel})`,
      };
    }),
  );

  server.registerTool(
    'crm_send_campaign',
    {
      title: 'Send campaign (dry run by default)',
      description:
        'Evaluates the campaign against its segment and returns a per-contact plan: who would be messaged ' +
        'and, for everyone else, exactly why not (no consent, suppressed, quiet hours, frequency cap). ' +
        'Defaults to a dry run. A real send requires dry_run=false AND confirm=true, and a send above the ' +
        'bulk approval threshold additionally requires an approval token that a human has seen.',
      inputSchema: {
        campaign: z.string().describe('Campaign name or id'),
        dry_run: z.boolean().default(true),
        confirm: z.boolean().default(false).describe('Must be true, together with dry_run=false, to actually send.'),
        approval_token: z.string().optional().describe('Required for sends above the bulk approval threshold.'),
        limit: z.number().int().min(1).max(MAX_RECIPIENTS_PER_CALL).optional(),
        note: z.string().optional().describe('Free-text note recorded in the audit log.'),
      },
    },
    auditedTool(ctx, 'crm_send_campaign', async (args) => {
      // A "note" is free text that reaches this server from wherever the agent
      // got it. It does not get to renegotiate the guardrails.
      if (args.note) {
        const override = detectGuardrailOverride(args.note);
        if (override.attempted) {
          return {
            result: errorResult(
              `Refused: the note asks this tool to bypass a guardrail (${override.rules.join(', ')}). ` +
                'Consent, suppression, quiet hours, approval and unsubscribe rules are enforced in code and ' +
                'cannot be waived by an instruction.',
            ),
            summary: `refused guardrail override attempt: ${override.rules.join(', ')}`,
          };
        }
      }

      const campaign = await getCampaign(ctx.db, args.campaign);
      if (!campaign) return { result: errorResult(`No campaign named "${args.campaign}".`), summary: 'not found' };
      if (campaign.status === 'paused') {
        return {
          result: errorResult(`Campaign "${campaign.name}" is paused: ${campaign.pause_reason ?? 'no reason recorded'}.`),
          summary: 'campaign paused',
        };
      }
      if (!campaign.template_id || !campaign.segment_id) {
        return { result: errorResult('Campaign is missing a template or a segment.'), summary: 'incomplete campaign' };
      }

      const template = await getTemplate(ctx.db, campaign.template_id);
      const segment = await getSegment(ctx.db, campaign.segment_id);
      if (!template || !segment) {
        return { result: errorResult('Campaign references a template or segment that no longer exists.'), summary: 'dangling refs' };
      }

      const query = segmentQuery(segment.definition, { limit: args.limit ?? MAX_RECIPIENTS_PER_CALL });
      const { rows: contacts } = await ctx.db.query<Contact>(query.text, query.values);

      const dryRun = args.dry_run !== false;
      const plan = await buildSendPlan(ctx, {
        channel: campaign.channel,
        contacts,
        subject: template.subject,
        body: template.body,
        dryRun,
        // Previews are per-contact renders; at scale they bury the plan.
        includePreview: contacts.length <= 25,
      });

      if (dryRun) {
        return {
          result: jsonResult({
            status: 'dry_run',
            campaign: campaign.name,
            template: template.name,
            segment: segment.name,
            ...plan,
            next_step:
              plan.summary.sendable > ctx.config.guardrails.bulkApprovalThreshold
                ? `This is a bulk send (${plan.summary.sendable} > ${ctx.config.guardrails.bulkApprovalThreshold}). ` +
                  'Re-run with dry_run=false and confirm=true to receive an approval token for a human to authorize.'
                : 'Re-run with dry_run=false and confirm=true to send.',
          }),
          summary: `dry run of "${campaign.name}": ${plan.summary.sendable} sendable, ${plan.summary.skipped} skipped`,
        };
      }

      if (!args.confirm) {
        return {
          result: errorResult('A real send requires confirm=true as well as dry_run=false. Nothing was sent.', {
            would_send: plan.summary.sendable,
          }),
          summary: 'send not confirmed',
        };
      }

      if (plan.compliance_issues.length > 0) {
        return {
          result: errorResult('Send blocked by compliance issues in the rendered message.', {
            compliance_issues: plan.compliance_issues,
            hint: 'Set UNSUBSCRIBE_BASE_URL and SENDER_PHYSICAL_ADDRESS, or fix the template copy.',
          }),
          summary: `blocked: ${plan.compliance_issues.length} compliance issue(s)`,
        };
      }

      const threshold = ctx.config.guardrails.bulkApprovalThreshold;
      if (plan.summary.sendable > threshold) {
        const valid = verifyApprovalToken(
          args.approval_token,
          campaign.id,
          plan.summary.sendable,
          ctx.config.bearerToken,
          ctx.now(),
        );
        if (!valid) {
          const token = approvalToken(campaign.id, plan.summary.sendable, ctx.config.bearerToken, ctx.now());
          return {
            result: jsonResult({
              status: 'needs_human_approval',
              campaign: campaign.name,
              recipients: plan.summary.sendable,
              threshold,
              estimated_cost_usd: plan.summary.estimated_cost_usd,
              approval_token: token,
              note:
                `Sending to ${plan.summary.sendable} contacts is above the bulk threshold of ${threshold}. ` +
                'A human should review this plan and the recipient count, then re-run this tool with ' +
                'approval_token set. The token is bound to this campaign, this exact recipient count and ' +
                'today only. Nothing has been sent.',
              summary: plan.summary,
            }),
            summary: `needs human approval for ${plan.summary.sendable} recipients`,
          };
        }
      }

      if (!plan.budget.allowed) {
        await setCampaignStatus(ctx.db, campaign.id, 'paused', plan.budget.reason ?? 'daily spend ceiling reached');
        return {
          result: jsonResult({
            status: 'paused',
            reason: plan.budget.reason,
            campaign: campaign.name,
            note: 'Nothing was sent. Raise DAILY_SPEND_CEILING_USD or resume tomorrow, then unpause.',
          }),
          summary: `paused "${campaign.name}": budget ceiling`,
        };
      }

      const adapter = ctx.adapters[campaign.channel];
      if (!adapter.configured) {
        return {
          result: errorResult(
            `The ${campaign.channel} channel is not configured, so nothing can be sent. Dry runs still work.`,
          ),
          summary: `channel ${campaign.channel} unconfigured`,
        };
      }

      await setCampaignStatus(ctx.db, campaign.id, 'sending', null);
      const result = await executeSendPlan(ctx, {
        channel: campaign.channel,
        contacts,
        subject: template.subject,
        body: template.body,
        dryRun: false,
        plan,
        campaignId: campaign.id,
      });

      const rateLimited = (result.skipped_by_reason.skipped_rate_limit ?? 0) > 0;
      await setCampaignStatus(
        ctx.db,
        campaign.id,
        rateLimited ? 'paused' : 'sent',
        rateLimited ? 'Send-rate ceiling reached mid-send; re-run to deliver the remainder.' : null,
      );
      await ctx.db.query('update crm.campaigns set dry_run = false where id = $1', [campaign.id]);

      return {
        result: jsonResult({
          status: rateLimited ? 'partially_sent' : 'sent',
          campaign: campaign.name,
          ...result,
          note: rateLimited
            ? 'The send-rate ceiling was reached. The campaign is paused; re-run it to deliver the remainder.'
            : undefined,
        }),
        summary: `sent "${campaign.name}": ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped`,
      };
    }),
  );

  server.registerTool(
    'crm_pause_campaign',
    {
      title: 'Pause or resume campaign',
      description: 'Pauses a campaign (or resumes a paused one). A paused campaign refuses to send.',
      inputSchema: {
        campaign: z.string(),
        action: z.enum(['pause', 'resume']).default('pause'),
        reason: z.string().optional(),
      },
    },
    auditedTool(ctx, 'crm_pause_campaign', async (args) => {
      const campaign = await getCampaign(ctx.db, args.campaign);
      if (!campaign) return { result: errorResult(`No campaign named "${args.campaign}".`), summary: 'not found' };

      if ((args.action ?? 'pause') === 'pause') {
        await setCampaignStatus(ctx.db, campaign.id, 'paused', args.reason ?? 'paused manually');
        return {
          result: jsonResult({ status: 'paused', campaign: campaign.name, reason: args.reason ?? 'paused manually' }),
          summary: `paused "${campaign.name}"`,
        };
      }

      await setCampaignStatus(ctx.db, campaign.id, 'draft', null);
      return {
        result: jsonResult({ status: 'resumed', campaign: campaign.name, campaign_status: 'draft' }),
        summary: `resumed "${campaign.name}"`,
      };
    }),
  );

  server.registerTool(
    'crm_get_campaign',
    {
      title: 'Get campaign',
      description: 'Returns a campaign with its template, segment and message-status counts.',
      inputSchema: { campaign: z.string() },
    },
    readTool(async (args) => {
      const campaign = await getCampaign(ctx.db, args.campaign);
      if (!campaign) return errorResult(`No campaign named "${args.campaign}".`);

      const { rows: statusRows } = await ctx.db.query<{ status: string; count: string }>(
        `select status, count(*)::text as count from crm.messages where campaign_id = $1 group by status`,
        [campaign.id],
      );

      return jsonResult({
        campaign,
        message_counts: Object.fromEntries(statusRows.map((r) => [r.status, Number(r.count)])),
      });
    }),
  );

  server.registerTool(
    'crm_list_campaigns',
    {
      title: 'List campaigns',
      description: 'Lists campaigns, most recent first.',
      inputSchema: {
        status: z.enum(['draft', 'scheduled', 'sending', 'paused', 'sent', 'failed']).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    readTool(async (args) => {
      const { rows } = await ctx.db.query(
        `select id, name, channel, status, scheduled_at, dry_run, pause_reason, created_at
         from crm.campaigns
         where ($1::text is null or status = $1)
         order by created_at desc limit $2`,
        [args.status ?? null, args.limit ?? 25],
      );
      return jsonResult({ count: rows.length, campaigns: rows });
    }),
  );
}
