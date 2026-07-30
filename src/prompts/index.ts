import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';

const userMessage = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
});

export function registerPrompts(server: McpServer, ctx: ServerContext): void {
  server.registerPrompt(
    'draft_campaign',
    {
      title: 'Draft a campaign',
      description:
        'Turns a goal and an audience into a complete dry-run plan -- segment, copy and schedule -- for a ' +
        'human to approve. Leads with the video-call hook.',
      argsSchema: {
        goal: z.string().describe('What the campaign should achieve, e.g. "convert day-7 trial users"'),
        audience: z.string().describe('Who it targets, e.g. "trial users who used a video call"'),
        channel: z.string().optional().describe('email, sms or push. Defaults to email.'),
      },
    },
    ({ goal, audience, channel }) =>
      userMessage(
        `Draft a ${channel ?? 'email'} campaign for AI Bestie.

Goal: ${goal}
Audience: ${audience}

Work in this order, using the crm_* tools, and stop for approval before anything sends:

1. Read crm://compliance/policy so you are working against the guardrails actually in force.
2. Translate the audience into a segment with crm_create_segment (a filter AST, never SQL), then
   crm_preview_segment to see the real size. If the segment is empty or implausibly large, say so and stop.
3. Generate copy with crm_generate_copy. Lead with the live video call -- the user points their camera at a
   real problem and Bestie sees it and talks them through it -- and use free unlimited chat as the
   no-risk hook. Stay inside the honest framing: free video is 10 minutes a day, free voice is 5, chat
   really is unlimited, and Bestie is not a licensed professional.
4. Save it with crm_create_template, then crm_render_preview against one real contact so you can see the
   unsubscribe footer and physical address (or the STOP notice) exactly as it will send.
5. crm_create_campaign, then crm_send_campaign as a DRY RUN.
6. Present: segment size, sendable count, the skip breakdown with reasons, estimated cost, and the rendered
   message. Recommend a send time in the audience's local hours.

Do not set dry_run=false. The human decides that after reading the plan.`,
      ),
  );

  server.registerPrompt(
    'weekly_growth_report',
    {
      title: 'Weekly growth report',
      description: 'Funnel, campaign performance, unit economics and three concrete recommended actions.',
      argsSchema: {
        spend_usd: z.string().optional().describe('Acquisition spend for the week, for CAC'),
      },
    },
    ({ spend_usd }) =>
      userMessage(
        `Write this week's growth report for AI Bestie.

Gather:
- crm://overview for the funnel snapshot and week-over-week deltas.
- crm_funnel_metrics with days=7 and compare_previous=true.
- crm_campaign_metrics for each campaign that sent this week (crm_list_campaigns to find them).
- crm_top_channels and crm_feature_engagement -- does the video-call hook convert better than chat?
- crm_get_referral_stats for the refer-a-friend program.
- crm_ltv_cac with spend_usd=${spend_usd ?? '<ask the user for the week\'s spend>'}.

Then write:
1. What moved, in numbers, versus last week. Lead with the metric that changed most.
2. Campaign performance, including the skip breakdown -- skipped_no_consent and skipped_suppressed are
   the compliance system working, not failures. Call out anything that looks like a deliverability problem.
3. Unit economics: LTV, CAC, payback, and whether the ratio is healthy.
4. Exactly three recommended actions for next week, each with the audience, the channel and the reason
   the data supports it. No vague advice.

Be honest about weak numbers. Guardrails set: frequency cap ${ctx.config.guardrails.frequencyCap} per ` +
          `${ctx.config.guardrails.frequencyWindowDays} days, bulk approval above ` +
          `${ctx.config.guardrails.bulkApprovalThreshold} recipients, $${ctx.config.guardrails.dailySpendCeilingUsd} daily ceiling.`,
      ),
  );
}
