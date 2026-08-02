import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { errorResult, jsonResult, readTool } from './helpers.js';
import { num } from '../db/pool.js';
import {
  computeCampaignMetrics,
  computeFunnel,
  computeLtvCac,
  rankChannels,
  type ChannelRow,
  type FunnelCounts,
  type StatusCounts,
} from '../core/funnel.js';
import { getCampaign } from '../db/repo.js';

/** Counts every event type in one pass over the window. */
export async function funnelCounts(ctx: ServerContext, days: number): Promise<FunnelCounts> {
  const { rows } = await ctx.db.query<{ type: string; count: string }>(
    `select type, count(*)::text as count from crm.events
     where occurred_at > now() - ($1::int * interval '1 day')
     group by type`,
    [days],
  );
  const byType = new Map(rows.map((r) => [r.type, num(r.count)]));
  return {
    visitors: byType.get('visit') ?? 0,
    signups: byType.get('signup') ?? 0,
    trials: byType.get('trial_start') ?? 0,
    subscribers: byType.get('subscribe') ?? 0,
    cancels: byType.get('cancel') ?? 0,
  };
}

export function registerAnalyticsTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'crm_funnel_metrics',
    {
      title: 'Funnel metrics',
      description:
        'Visitors to signups to trials to subscribers to cancels, with conversion rates, built from ' +
        'crm.events -- which the app backend feeds through the event bridge.',
      inputSchema: {
        days: z.number().int().min(1).max(365).default(30),
        compare_previous: z.boolean().default(true).describe('Also return the previous period and the deltas.'),
      },
    },
    readTool(async (args) => {
      const days = args.days ?? 30;
      const current = computeFunnel(await funnelCounts(ctx, days));

      if (args.compare_previous === false) {
        return jsonResult({ window_days: days, current });
      }

      // The "previous" window is everything from 2N to N days ago.
      const { rows } = await ctx.db.query<{ type: string; count: string }>(
        `select type, count(*)::text as count from crm.events
         where occurred_at > now() - ($1::int * interval '1 day')
           and occurred_at <= now() - ($2::int * interval '1 day')
         group by type`,
        [days * 2, days],
      );
      const byType = new Map(rows.map((r) => [r.type, num(r.count)]));
      const previous = computeFunnel({
        visitors: byType.get('visit') ?? 0,
        signups: byType.get('signup') ?? 0,
        trials: byType.get('trial_start') ?? 0,
        subscribers: byType.get('subscribe') ?? 0,
        cancels: byType.get('cancel') ?? 0,
      });

      return jsonResult({
        window_days: days,
        current,
        previous,
        deltas: {
          signups: current.signups - previous.signups,
          trials: current.trials - previous.trials,
          subscribers: current.subscribers - previous.subscribers,
          cancels: current.cancels - previous.cancels,
        },
      });
    }),
  );

  server.registerTool(
    'crm_campaign_metrics',
    {
      title: 'Campaign metrics',
      description:
        'Delivery, open, click and bounce rates for a campaign, plus the breakdown of who was skipped ' +
        'and why -- the skip reasons are the compliance record, not an error list.',
      inputSchema: { campaign: z.string() },
    },
    readTool(async (args) => {
      const campaign = await getCampaign(ctx.db, args.campaign);
      if (!campaign) return errorResult(`No campaign named "${args.campaign}".`);

      const { rows } = await ctx.db.query<{ status: string; count: string }>(
        `select status, count(*)::text as count from crm.messages where campaign_id = $1 group by status`,
        [campaign.id],
      );
      const counts: StatusCounts = {};
      for (const row of rows) {
        counts[row.status as keyof StatusCounts] = num(row.count);
      }

      return jsonResult({
        campaign: campaign.name,
        channel: campaign.channel,
        status: campaign.status,
        metrics: computeCampaignMetrics(counts),
      });
    }),
  );

  server.registerTool(
    'crm_ltv_cac',
    {
      title: 'LTV / CAC',
      description:
        'Unit economics: LTV from ARPU, margin and churn; CAC from the spend you supply and customers ' +
        'acquired. Subscriber and churn figures come from public.crm_v_subscriptions when the app has ' +
        'granted it, otherwise from crm.events.',
      inputSchema: {
        spend_usd: z.number().min(0).describe('Acquisition spend over the window'),
        days: z.number().int().min(1).max(365).default(30),
        arpu_monthly_usd: z.number().min(0).default(9.99).describe('Bestie Pro is $9.99/mo'),
        gross_margin: z.number().min(0).max(1).default(0.6).describe('After store fees and API costs'),
        monthly_churn_rate: z.number().min(0).max(1).optional().describe('Defaults to the observed rate'),
        new_customers: z.number().int().min(0).optional().describe('Defaults to subscribe events in the window'),
      },
    },
    readTool(async (args) => {
      const days = args.days ?? 30;
      const counts = await funnelCounts(ctx, days);
      const notes: string[] = [];

      let activeSubscribers: number | null = null;
      let cancelled: number | null = null;
      try {
        const { rows } = await ctx.db.query<{ status: string; count: string }>(
          `select status, count(*)::text as count from public.crm_v_subscriptions group by status`,
        );
        const byStatus = new Map(rows.map((r) => [r.status, num(r.count)]));
        activeSubscribers = byStatus.get('active') ?? 0;
        cancelled = (byStatus.get('cancelled') ?? 0) + (byStatus.get('canceled') ?? 0) + (byStatus.get('expired') ?? 0);
      } catch {
        notes.push(
          'public.crm_v_subscriptions is not readable, so subscriber figures come from crm.events instead. ' +
            'The app team creates and grants that view (§4b).',
        );
      }

      const newCustomers = args.new_customers ?? counts.subscribers;
      const churn =
        args.monthly_churn_rate ??
        (activeSubscribers !== null && activeSubscribers > 0 && cancelled !== null
          ? Math.min(1, cancelled / (activeSubscribers + cancelled)) * (30 / days)
          : counts.subscribers > 0
            ? Math.min(1, counts.cancels / counts.subscribers) * (30 / days)
            : 0);

      const metrics = computeLtvCac({
        arpuMonthlyUsd: args.arpu_monthly_usd ?? 9.99,
        grossMargin: args.gross_margin ?? 0.6,
        monthlyChurnRate: Math.round(churn * 10_000) / 10_000,
        spendUsd: args.spend_usd,
        newCustomers,
      });

      return jsonResult({
        window_days: days,
        inputs: {
          arpu_monthly_usd: args.arpu_monthly_usd ?? 9.99,
          gross_margin: args.gross_margin ?? 0.6,
          monthly_churn_rate: Math.round(churn * 10_000) / 10_000,
          spend_usd: args.spend_usd,
          new_customers: newCustomers,
        },
        active_subscribers: activeSubscribers,
        metrics,
        notes: [...metrics.notes, ...notes],
      });
    }),
  );

  server.registerTool(
    'crm_top_channels',
    {
      title: 'Top acquisition channels',
      description: 'Ranks contact sources by subscribers and conversion rate.',
      inputSchema: { days: z.number().int().min(1).max(365).default(90) },
    },
    readTool(async (args) => {
      const days = args.days ?? 90;
      const { rows } = await ctx.db.query<{
        source: string | null;
        contacts: string;
        signups: string;
        subscribers: string;
      }>(
        `select coalesce(c.source, 'unknown') as source,
                count(distinct c.id)::text as contacts,
                count(distinct e.contact_id) filter (where e.type = 'signup')::text as signups,
                count(distinct e.contact_id) filter (where e.type = 'subscribe')::text as subscribers
         from crm.contacts c
         left join crm.events e
           on e.contact_id = c.id
          and e.occurred_at > now() - ($1::int * interval '1 day')
         group by 1`,
        [days],
      );

      const channels: ChannelRow[] = rows.map((r) => ({
        source: r.source ?? 'unknown',
        contacts: num(r.contacts),
        signups: num(r.signups),
        subscribers: num(r.subscribers),
      }));

      return jsonResult({ window_days: days, channels: rankChannels(channels) });
    }),
  );

  server.registerTool(
    'crm_feature_engagement',
    {
      title: 'Feature engagement',
      description:
        'Video-call versus chat usage from crm.events, and how each correlates with subscribing. Useful for ' +
        'checking whether the video-call hook actually converts better than the free-chat hook.',
      inputSchema: { days: z.number().int().min(1).max(365).default(30) },
    },
    readTool(async (args) => {
      const days = args.days ?? 30;
      const { rows } = await ctx.db.query<{
        feature: string;
        users: string;
        uses: string;
        subscribers: string;
      }>(
        `with used as (
           select contact_id, type, count(*)::int as uses
           from crm.events
           where type in ('video_call_used','chat_used')
             and occurred_at > now() - ($1::int * interval '1 day')
             and contact_id is not null
           group by 1,2
         ),
         subs as (
           select distinct contact_id from crm.events
           where type = 'subscribe' and occurred_at > now() - ($1::int * interval '1 day')
         )
         select u.type as feature,
                count(distinct u.contact_id)::text as users,
                sum(u.uses)::text as uses,
                count(distinct u.contact_id) filter (where s.contact_id is not null)::text as subscribers
         from used u left join subs s on s.contact_id = u.contact_id
         group by 1`,
        [days],
      );

      const features = rows.map((r) => {
        const users = num(r.users);
        const subscribers = num(r.subscribers);
        return {
          feature: r.feature,
          users,
          uses: num(r.uses),
          subscribers,
          subscribe_rate: users > 0 ? Math.round((subscribers / users) * 10_000) / 10_000 : 0,
        };
      });

      return jsonResult({
        window_days: days,
        features,
        note:
          features.length === 0
            ? 'No video_call_used or chat_used events yet. The app backend emits these through the event bridge (§4c).'
            : undefined,
      });
    }),
  );
}
