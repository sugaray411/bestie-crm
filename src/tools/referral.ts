import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { auditedTool, errorResult, jsonResult, readTool } from './helpers.js';
import { num } from '../db/pool.js';
import { checkCopyTruthfulness } from '../core/compliance.js';
import { CopyGenerationError } from '../core/copygen.js';
import { templateVariables } from '../core/render.js';

/**
 * The referral program already exists in the app: the referrer earns one month
 * of Pro when their friend actually subscribes. The CRM reads its performance
 * and generates share copy -- it never awards or promises a reward itself.
 */
export function registerReferralTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'crm_get_referral_stats',
    {
      title: 'Referral stats',
      description:
        'Referral performance by referrer code, read from public.crm_v_referrals (the app owns the raw ' +
        'referrals table; the CRM only sees these aggregates).',
      inputSchema: {
        referrer_code: z.string().optional().describe('Limit to one code'),
        limit: z.number().int().min(1).max(200).default(25),
      },
    },
    readTool(async (args) => {
      try {
        const { rows } = await ctx.db.query<{ referrer_code: string; converted: string; total: string }>(
          `select referrer_code, converted::text, total::text from public.crm_v_referrals
           where ($1::text is null or referrer_code = $1)
           order by converted desc, total desc limit $2`,
          [args.referrer_code ?? null, args.limit ?? 25],
        );

        const referrers = rows.map((r) => ({
          referrer_code: r.referrer_code,
          total_referrals: num(r.total),
          converted: num(r.converted),
          conversion_rate: num(r.total) > 0 ? Math.round((num(r.converted) / num(r.total)) * 10_000) / 10_000 : 0,
        }));

        const totals = referrers.reduce(
          (acc, r) => ({
            total_referrals: acc.total_referrals + r.total_referrals,
            converted: acc.converted + r.converted,
          }),
          { total_referrals: 0, converted: 0 },
        );

        return jsonResult({
          referrers,
          totals: {
            ...totals,
            conversion_rate:
              totals.total_referrals > 0
                ? Math.round((totals.converted / totals.total_referrals) * 10_000) / 10_000
                : 0,
          },
          note: 'A referral counts as converted only when the friend actually subscribed. Rewards are issued by the app, not by the CRM.',
        });
      } catch (err) {
        return errorResult(
          'public.crm_v_referrals is not readable. The app team creates this view and grants SELECT to ' +
            `crm_service (§4b). Underlying error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  server.registerTool(
    'crm_create_referral_campaign',
    {
      title: 'Create referral campaign',
      description:
        'Generates share copy and tracked links for the existing refer-a-friend program, and saves it as a ' +
        'template. The reward terms are stated honestly: the referrer earns a month of Pro only when their ' +
        'friend actually subscribes.',
      inputSchema: {
        name: z.string().min(2),
        channel: z.enum(['email', 'sms', 'push']).default('email'),
        share_base_url: z.string().url().describe('Referral landing page, e.g. https://bestie.app/r'),
        audience: z.string().optional().describe('e.g. "active Pro subscribers with 30+ days"'),
        generate_copy: z.boolean().default(true).describe('Use Claude for the copy; false returns a safe default.'),
      },
    },
    auditedTool(ctx, 'crm_create_referral_campaign', async (args) => {
      const channel = args.channel ?? 'email';
      const base = args.share_base_url.replace(/\/+$/, '');
      // The link carries the referrer's own code, substituted per contact at
      // render time -- so one template serves everybody.
      const shareLink = `${base}/{{referral_code}}`;

      let subject: string | null = null;
      let body: string;

      const fallbackBody =
        `You know that thing where you point your camera at a problem and Bestie just... sees it? ` +
        `The leaking pipe, the confusing form, the plant you cannot identify.\n\n` +
        `Share Bestie with a friend: ${shareLink}\n\n` +
        `Chatting with her is free and unlimited, so there is nothing for them to lose. ` +
        `If they go Pro, you get a month of Pro free.`;

      if (args.generate_copy !== false && ctx.copy.available) {
        try {
          const generated = await ctx.copy.generate({
            channel,
            goal:
              'Ask an existing happy user to share Bestie with a friend. Include the share link placeholder ' +
              `${shareLink} verbatim. State the reward accurately: the referrer gets one month of Pro free ` +
              'when their friend actually subscribes -- not for signing up, not for installing.',
            audience: args.audience ?? 'existing happy users',
            variables: ['first_name', 'referral_code'],
          });
          subject = generated.subject ?? null;
          body = generated.body.includes('{{referral_code}}')
            ? generated.body
            : `${generated.body}\n\n${shareLink}`;
        } catch (err) {
          if (!(err instanceof CopyGenerationError)) throw err;
          subject = 'Show a friend the thing Bestie does';
          body = fallbackBody;
        }
      } else {
        subject = 'Show a friend the thing Bestie does';
        body = fallbackBody;
      }

      // Belt and braces: the fallback path never went through the copy engine's
      // own check, and a reward claim is exactly the kind of thing that must not
      // drift.
      const check = checkCopyTruthfulness(`${subject ?? ''}\n${body}`);
      if (!check.ok) {
        return {
          result: errorResult('Referral copy rejected by the truthfulness rules.', { violations: check.violations }),
          summary: `rejected referral copy for "${args.name}"`,
        };
      }

      const variables = [...new Set([...templateVariables(body), ...templateVariables(subject ?? '')])];
      const { rows } = await ctx.db.query<{ id: string }>(
        `insert into crm.templates (channel, name, subject, body, variables)
         values ($1,$2,$3,$4,$5)
         on conflict (name) do update
           set subject = excluded.subject, body = excluded.body, variables = excluded.variables
         returning id`,
        [channel, args.name, subject, body, variables],
      );

      return {
        result: jsonResult({
          template_id: rows[0]!.id,
          name: args.name,
          channel,
          subject,
          body,
          variables,
          share_link_pattern: shareLink,
          note:
            'Saved as a template. Create a segment and a campaign to send it. {{referral_code}} must be ' +
            "supplied per contact -- the reward fires from the app's existing program when the friend subscribes.",
        }),
        summary: `created referral template "${args.name}" (${channel})`,
      };
    }),
  );
}
