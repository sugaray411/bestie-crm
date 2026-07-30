import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { num } from '../db/pool.js';
import { computeCampaignMetrics, computeFunnel, type StatusCounts } from '../core/funnel.js';
import { funnelCounts } from '../tools/analytics.js';
import { getCampaign, getSegment } from '../db/repo.js';
import { segmentQuery } from '../core/segmentAst.js';
import { SEGMENT_FIELDS, SEGMENT_OPERATORS } from '../core/segmentAst.js';

const json = (uri: string, data: unknown) => ({
  contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
});

export function registerResources(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    'overview',
    'crm://overview',
    {
      title: 'Growth overview',
      description: 'Funnel snapshot for the last 7 and 30 days, with week-over-week deltas and recent campaigns.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const [last7, prev7, last30] = await Promise.all([
        funnelCounts(ctx, 7),
        (async () => {
          const { rows } = await ctx.db.query<{ type: string; count: string }>(
            `select type, count(*)::text as count from crm.events
             where occurred_at > now() - interval '14 days' and occurred_at <= now() - interval '7 days'
             group by type`,
          );
          const byType = new Map(rows.map((r) => [r.type, num(r.count)]));
          return {
            visitors: byType.get('visit') ?? 0,
            signups: byType.get('signup') ?? 0,
            trials: byType.get('trial_start') ?? 0,
            subscribers: byType.get('subscribe') ?? 0,
            cancels: byType.get('cancel') ?? 0,
          };
        })(),
        funnelCounts(ctx, 30),
      ]);

      const [{ rows: contactRows }, { rows: campaignRows }, { rows: consentRows }] = await Promise.all([
        ctx.db.query<{ lifecycle_stage: string; count: string }>(
          `select lifecycle_stage, count(*)::text as count from crm.contacts group by 1`,
        ),
        ctx.db.query(
          `select name, channel, status, created_at from crm.campaigns order by created_at desc limit 5`,
        ),
        ctx.db.query<{ channel: string; count: string }>(
          `select channel, count(*)::text as count from (
             select distinct on (contact_id, channel) contact_id, channel, status
             from crm.consents order by contact_id, channel, ts desc
           ) latest where status = 'granted' group by channel`,
        ),
      ]);

      return json(uri.href, {
        generated_at: ctx.now().toISOString(),
        last_7_days: computeFunnel(last7),
        previous_7_days: computeFunnel(prev7),
        week_over_week: {
          signups: last7.signups - prev7.signups,
          trials: last7.trials - prev7.trials,
          subscribers: last7.subscribers - prev7.subscribers,
          cancels: last7.cancels - prev7.cancels,
        },
        last_30_days: computeFunnel(last30),
        contacts_by_stage: Object.fromEntries(contactRows.map((r) => [r.lifecycle_stage, num(r.count)])),
        consented_contacts_by_channel: Object.fromEntries(consentRows.map((r) => [r.channel, num(r.count)])),
        recent_campaigns: campaignRows,
      });
    },
  );

  server.registerResource(
    'compliance-policy',
    'crm://compliance/policy',
    {
      title: 'Compliance policy (live)',
      description: 'The guardrails currently in force, read from the running configuration -- not a copy of the docs.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const g = ctx.config.guardrails;
      const { rows: suppressionRows } = await ctx.db.query<{ channel: string; count: string }>(
        `select channel, count(*)::text as count from crm.suppression group by channel`,
      );

      return json(uri.href, {
        non_negotiable: [
          'No message without consent. Every send resolves consent first; no grant means skipped_no_consent.',
          'Suppression is absolute. A suppressed address is never messaged, whatever consent says.',
          'Every email carries a working unsubscribe link and a physical mailing address (CAN-SPAM).',
          'Every SMS carries a STOP notice, and inbound STOP suppresses immediately (TCPA).',
          'No purchased, rented, scraped or appended lists. Imports require a lawful basis and an attestation.',
          'GDPR/CCPA: contacts can be exported and erased; EU/UK contacts need an explicit opt-in.',
          'Quiet hours and frequency caps apply to SMS and push.',
          'Per-channel rate limits and a daily spend ceiling; exceeding either pauses the campaign.',
          'Dry run first; bulk sends need human approval.',
          'Audit args are redacted; message bodies with PII are never logged.',
          'Truthful advertising only: no fabricated testimonials, no fake scarcity, no claims Bestie cannot back up.',
        ],
        enforced_values: {
          bulk_approval_threshold: g.bulkApprovalThreshold,
          frequency_cap: g.frequencyCap,
          frequency_window_days: g.frequencyWindowDays,
          daily_spend_ceiling_usd: g.dailySpendCeilingUsd,
          send_rate_per_minute: g.sendRatePerMinute,
          quiet_hours_local: `${g.quietHoursStart}:00-${g.quietHoursEnd}:00 (SMS and push only)`,
          unsubscribe_base_url_configured: Boolean(g.unsubscribeBaseUrl),
          sender_physical_address_configured: Boolean(g.senderPhysicalAddress),
        },
        configuration_warnings: [
          g.unsubscribeBaseUrl ? null : 'UNSUBSCRIBE_BASE_URL is not set: email sends will be blocked.',
          g.senderPhysicalAddress ? null : 'SENDER_PHYSICAL_ADDRESS is not set: email sends will be blocked.',
        ].filter((w): w is string => w !== null),
        channels_configured: {
          email: ctx.adapters.email.configured,
          sms: ctx.adapters.sms.configured,
          push: ctx.adapters.push.configured,
        },
        suppression_list_size: Object.fromEntries(suppressionRows.map((r) => [r.channel, num(r.count)])),
        honest_product_claims: {
          chat: 'Free and unlimited, forever.',
          video_call: 'Free tier gets 10 minutes of camera-during-calls per day. Pro removes the limit.',
          voice_call: 'Free tier gets 5 minutes per day. Pro removes the limit.',
          pro_price_usd_monthly: 9.99,
          privacy: 'We do not collect or sell user data.',
          disclaimer: 'Bestie assists; she is not a licensed professional.',
        },
      });
    },
  );

  server.registerResource(
    'campaign',
    new ResourceTemplate('crm://campaigns/{id}', { list: undefined }),
    {
      title: 'Campaign detail',
      description: 'One campaign with its message-status breakdown and computed metrics.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const campaign = await getCampaign(ctx.db, id);
      if (!campaign) return json(uri.href, { error: `No campaign "${id}".` });

      const { rows } = await ctx.db.query<{ status: string; count: string }>(
        `select status, count(*)::text as count from crm.messages where campaign_id = $1 group by status`,
        [campaign.id],
      );
      const counts: StatusCounts = {};
      for (const row of rows) counts[row.status as keyof StatusCounts] = num(row.count);

      return json(uri.href, { campaign, metrics: computeCampaignMetrics(counts) });
    },
  );

  server.registerResource(
    'segment',
    new ResourceTemplate('crm://segments/{id}', { list: undefined }),
    {
      title: 'Segment detail',
      description: 'One segment: its definition, the compiled WHERE clause and how many contacts it matches.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const segment = await getSegment(ctx.db, id);
      if (!segment) {
        return json(uri.href, {
          error: `No segment "${id}".`,
          allowed_fields: SEGMENT_FIELDS,
          allowed_operators: SEGMENT_OPERATORS,
        });
      }
      const query = segmentQuery(segment.definition, { select: 'count(*)::int as count' });
      const { rows } = await ctx.db.query<{ count: number }>(query.text, query.values);
      return json(uri.href, {
        segment,
        matches: rows[0]?.count ?? 0,
        allowed_fields: SEGMENT_FIELDS,
        allowed_operators: SEGMENT_OPERATORS,
      });
    },
  );
}
