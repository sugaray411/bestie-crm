import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { auditedTool, errorResult, jsonResult, readTool } from './helpers.js';
import { CopyGenerationError } from '../core/copygen.js';
import {
  PLATFORM_RULES,
  SOCIAL_PLATFORMS,
  SOCIAL_POST_STATUSES,
  selectDuePosts,
  validateScheduleTime,
  validateSocialPost,
  type SocialPlatform,
  type SocialPostStatus,
} from '../core/socialContent.js';

/**
 * Social content: draft, validate, schedule, approve, publish.
 *
 * The gate here is different from the messaging one and deliberately so.
 * Consent and suppression govern messages to identified people; a social post
 * is a broadcast to followers. What carries over is truthfulness -- checked on
 * every write -- and the human approval step, because an untrue or off-brand
 * post is public and permanent in a way an email to one person is not.
 */

/** Extends SchedulablePost so selectDuePosts can narrow over these rows directly. */
interface SocialPostRow {
  id: string;
  account_id: string | null;
  platform: SocialPlatform;
  body: string;
  media_urls: string[];
  status: SocialPostStatus;
  scheduled_at: Date | null;
  approved_by: string | null;
  published_at: Date | null;
  external_url: string | null;
  error: string | null;
  created_at: Date;
}

const POST_COLUMNS = `id, account_id, platform, body, media_urls, status, scheduled_at,
  approved_by, approved_at, published_at, external_post_id, external_url, error, created_by, created_at`;

export function registerSocialTools(server: McpServer, ctx: ServerContext): void {
  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------
  server.registerTool(
    'crm_add_social_account',
    {
      title: 'Register a social account',
      description:
        'Records a social account the CRM may draft and schedule content for. This does not authenticate ' +
        'with the platform — publishing adapters are not implemented yet (see SOCIAL.md).',
      inputSchema: {
        platform: z.enum(SOCIAL_PLATFORMS),
        handle: z.string().min(1).describe('e.g. @aibestie'),
        display_name: z.string().optional(),
        external_id: z.string().optional().describe("The platform's own account id, once known"),
      },
    },
    auditedTool(ctx, 'crm_add_social_account', async (args) => {
      const { rows } = await ctx.db.query<{ id: string }>(
        `insert into crm.social_accounts (platform, handle, display_name, external_id)
         values ($1,$2,$3,$4)
         on conflict (platform, lower(handle)) do update
           set display_name = excluded.display_name,
               external_id = coalesce(excluded.external_id, crm.social_accounts.external_id),
               updated_at = now()
         returning id`,
        [args.platform, args.handle, args.display_name ?? null, args.external_id ?? null],
      );
      return {
        result: jsonResult({ id: rows[0]!.id, platform: args.platform, handle: args.handle }),
        summary: `registered ${args.platform} account ${args.handle}`,
      };
    }),
  );

  server.registerTool(
    'crm_list_social_accounts',
    {
      title: 'List social accounts',
      description: 'Lists registered social accounts.',
      inputSchema: { platform: z.enum(SOCIAL_PLATFORMS).optional() },
    },
    readTool(async (args) => {
      const { rows } = await ctx.db.query(
        `select id, platform, handle, display_name, external_id, status, created_at
         from crm.social_accounts
         where ($1::text is null or platform = $1)
         order by platform, handle`,
        [args.platform ?? null],
      );
      return jsonResult({ count: rows.length, accounts: rows });
    }),
  );

  // -------------------------------------------------------------------------
  // Drafting
  // -------------------------------------------------------------------------
  server.registerTool(
    'crm_generate_social_post',
    {
      title: 'Generate a social post',
      description:
        'Writes an on-brand social post with Claude, shaped to the platform, and saves it as a draft. ' +
        "Leads with Bestie's live video call and free unlimited chat, and is re-checked against the honest " +
        'framing before it is stored. Drafts publish nothing.',
      inputSchema: {
        platform: z.enum(SOCIAL_PLATFORMS),
        goal: z.string().min(5).describe('What this post should achieve'),
        audience: z.string().optional(),
        tone: z.string().optional(),
        variant_count: z.number().int().min(1).max(3).default(1),
        account: z.string().uuid().optional().describe('Account id to attach the draft to'),
        save: z.boolean().default(true).describe('Save as a draft. False returns copy without storing it.'),
      },
    },
    auditedTool(ctx, 'crm_generate_social_post', async (args) => {
      if (!ctx.copy.available) {
        return {
          result: errorResult('ANTHROPIC_API_KEY is not configured, so copy cannot be generated.'),
          summary: 'copy engine unavailable',
        };
      }

      try {
        const generated = await ctx.copy.generateSocial({
          platform: args.platform,
          goal: args.goal,
          audience: args.audience,
          tone: args.tone,
          variantCount: args.variant_count ?? 1,
        });

        const validation = validateSocialPost({ platform: args.platform, body: generated.body });

        let savedId: string | null = null;
        if (args.save !== false && validation.errors.length === 0) {
          const { rows } = await ctx.db.query<{ id: string }>(
            `insert into crm.social_posts (account_id, platform, body, status, created_by)
             values ($1,$2,$3,'draft',$4) returning id`,
            [args.account ?? null, args.platform, generated.body, ctx.config.actor],
          );
          savedId = rows[0]!.id;
        }

        return {
          result: jsonResult({
            post_id: savedId,
            platform: args.platform,
            body: generated.body,
            variants: generated.variants,
            validation,
            regenerated_for_compliance: generated.regenerated,
            note:
              savedId === null && args.save !== false
                ? 'Not saved: the generated post failed platform validation. See validation.errors.'
                : 'Draft only. Schedule and approve it before it can publish.',
          }),
          summary: `generated ${args.platform} post for "${args.goal.slice(0, 60)}"`,
        };
      } catch (err) {
        if (err instanceof CopyGenerationError) {
          return {
            result: errorResult(err.message, { violations: err.violations }),
            summary: `social copy refused: ${err.message.slice(0, 120)}`,
          };
        }
        throw err;
      }
    }),
  );

  server.registerTool(
    'crm_create_social_post',
    {
      title: 'Create a social post from your own copy',
      description:
        'Saves a hand-written social post as a draft. Validated against the platform limits and the same ' +
        'truthfulness rules the copy engine obeys — untrue claims are rejected here too.',
      inputSchema: {
        platform: z.enum(SOCIAL_PLATFORMS),
        body: z.string().min(1),
        media_urls: z.array(z.string().url()).optional(),
        account: z.string().uuid().optional(),
      },
    },
    auditedTool(ctx, 'crm_create_social_post', async (args) => {
      const validation = validateSocialPost({
        platform: args.platform,
        body: args.body,
        mediaUrls: args.media_urls,
      });
      if (!validation.ok) {
        return {
          result: errorResult('Post rejected.', {
            errors: validation.errors,
            truthfulness_violations: validation.truthfulnessViolations,
          }),
          summary: `rejected ${args.platform} post: ${validation.errors[0] ?? 'untruthful claim'}`,
        };
      }

      const { rows } = await ctx.db.query<{ id: string }>(
        `insert into crm.social_posts (account_id, platform, body, media_urls, status, created_by)
         values ($1,$2,$3,coalesce($4::text[],'{}'::text[]),'draft',$5) returning id`,
        [args.account ?? null, args.platform, args.body, args.media_urls ?? null, ctx.config.actor],
      );

      return {
        result: jsonResult({ post_id: rows[0]!.id, validation, status: 'draft' }),
        summary: `created ${args.platform} draft ${rows[0]!.id}`,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // Scheduling and approval
  // -------------------------------------------------------------------------
  server.registerTool(
    'crm_schedule_social_post',
    {
      title: 'Schedule a social post',
      description:
        'Sets when a draft should publish. Scheduling is not authorization — the post still needs ' +
        'crm_approve_social_post before it can go out.',
      inputSchema: {
        post_id: z.string().uuid(),
        scheduled_at: z.string().datetime().describe('ISO 8601, in the future'),
      },
    },
    auditedTool(ctx, 'crm_schedule_social_post', async (args) => {
      const timing = validateScheduleTime(args.scheduled_at, ctx.now());
      if (!timing.ok) {
        return { result: errorResult(timing.reason ?? 'Invalid schedule time.'), summary: 'bad schedule time' };
      }

      const { rows } = await ctx.db.query<SocialPostRow>(
        `update crm.social_posts
         set scheduled_at = $2, status = case when status = 'draft' then 'scheduled' else status end,
             updated_at = now()
         where id = $1 and status in ('draft','scheduled','approved')
         returning ${POST_COLUMNS}`,
        [args.post_id, args.scheduled_at],
      );
      if (rows.length === 0) {
        return {
          result: errorResult('No such post, or it has already published or been cancelled.'),
          summary: 'not schedulable',
        };
      }

      return {
        result: jsonResult({
          post: rows[0],
          note: 'Scheduled. It will not publish until it is also approved.',
        }),
        summary: `scheduled post ${args.post_id} for ${args.scheduled_at}`,
      };
    }),
  );

  server.registerTool(
    'crm_approve_social_post',
    {
      title: 'Approve a social post',
      description:
        'Marks a post as approved to publish. This is the human gate: a post is public and effectively ' +
        'permanent, so nothing publishes without it. Re-validates before approving.',
      inputSchema: {
        post_id: z.string().uuid(),
        approved_by: z.string().min(1).describe('Who is approving — recorded on the post and in the audit log'),
      },
    },
    auditedTool(ctx, 'crm_approve_social_post', async (args) => {
      const { rows: existing } = await ctx.db.query<SocialPostRow>(
        `select ${POST_COLUMNS} from crm.social_posts where id = $1`,
        [args.post_id],
      );
      const post = existing[0];
      if (!post) return { result: errorResult('No such post.'), summary: 'not found' };
      if (post.status === 'published') {
        return { result: errorResult('Already published.'), summary: 'already published' };
      }

      // Copy may have been edited since it was written; approving is the last
      // point at which we can catch it.
      const validation = validateSocialPost({
        platform: post.platform,
        body: post.body,
        mediaUrls: post.media_urls,
      });
      if (!validation.ok) {
        return {
          result: errorResult('Cannot approve: the post no longer passes validation.', {
            errors: validation.errors,
            truthfulness_violations: validation.truthfulnessViolations,
          }),
          summary: 'approval blocked by validation',
        };
      }

      await ctx.db.query(
        `update crm.social_posts set status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
         where id = $1`,
        [args.post_id, args.approved_by],
      );

      return {
        result: jsonResult({
          post_id: args.post_id,
          status: 'approved',
          scheduled_at: post.scheduled_at,
          warnings: validation.warnings,
          note: post.scheduled_at
            ? 'Approved. It becomes due at its scheduled time.'
            : 'Approved, but it has no scheduled time — it will not publish until one is set.',
        }),
        summary: `approved post ${args.post_id} (by ${args.approved_by})`,
      };
    }),
  );

  server.registerTool(
    'crm_cancel_social_post',
    {
      title: 'Cancel a social post',
      description: 'Cancels a post that has not published yet.',
      inputSchema: { post_id: z.string().uuid(), reason: z.string().optional() },
    },
    auditedTool(ctx, 'crm_cancel_social_post', async (args) => {
      const { rowCount } = await ctx.db.query(
        `update crm.social_posts set status = 'cancelled', error = $2, updated_at = now()
         where id = $1 and status <> 'published'`,
        [args.post_id, args.reason ?? null],
      );
      if ((rowCount ?? 0) === 0) {
        return {
          result: errorResult('No such post, or it has already published.'),
          summary: 'not cancellable',
        };
      }
      return {
        result: jsonResult({ post_id: args.post_id, status: 'cancelled' }),
        summary: `cancelled post ${args.post_id}`,
      };
    }),
  );

  server.registerTool(
    'crm_list_social_posts',
    {
      title: 'List social posts',
      description: 'Lists social posts, newest first, optionally filtered by status or platform.',
      inputSchema: {
        status: z.enum(SOCIAL_POST_STATUSES).optional(),
        platform: z.enum(SOCIAL_PLATFORMS).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
    },
    readTool(async (args) => {
      const { rows } = await ctx.db.query(
        `select ${POST_COLUMNS} from crm.social_posts
         where ($1::text is null or status = $1)
           and ($2::text is null or platform = $2)
         order by created_at desc limit $3`,
        [args.status ?? null, args.platform ?? null, args.limit ?? 25],
      );
      return jsonResult({ count: rows.length, posts: rows });
    }),
  );

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------
  server.registerTool(
    'crm_publish_due_posts',
    {
      title: 'Publish due social posts (dry run by default)',
      description:
        'Finds approved posts whose scheduled time has passed and publishes them. Dry run by default, ' +
        'like campaign sends. No publishing adapter is implemented for any platform yet, so a real run ' +
        'reports what could not be published and leaves those posts approved — use the dry run to collect ' +
        'the copy and post it by hand.',
      inputSchema: {
        dry_run: z.boolean().default(true),
        confirm: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    auditedTool(ctx, 'crm_publish_due_posts', async (args) => {
      const { rows } = await ctx.db.query<SocialPostRow>(
        `select ${POST_COLUMNS} from crm.social_posts
         where status = 'approved' and scheduled_at is not null
         order by scheduled_at asc limit $1`,
        [args.limit ?? 10],
      );
      const due = selectDuePosts(rows, ctx.now());
      const dryRun = args.dry_run !== false;

      if (dryRun) {
        return {
          result: jsonResult({
            status: 'dry_run',
            due_count: due.length,
            posts: due.map((p) => ({
              post_id: p.id,
              platform: p.platform,
              scheduled_at: p.scheduled_at,
              body: p.body,
              media_urls: p.media_urls,
              adapter_configured: ctx.socialAdapters[p.platform].configured,
            })),
            note: 'Dry run. Nothing was published. Re-run with dry_run=false and confirm=true to publish.',
          }),
          summary: `dry run: ${due.length} post(s) due`,
        };
      }

      if (!args.confirm) {
        return {
          result: errorResult('Publishing requires confirm=true as well as dry_run=false.', {
            would_publish: due.length,
          }),
          summary: 'publish not confirmed',
        };
      }

      const published: string[] = [];
      const failed: Array<{ post_id: string; error: string }> = [];

      for (const post of due) {
        const adapter = ctx.socialAdapters[post.platform];
        const result = await adapter.publish({
          platform: post.platform,
          body: post.body,
          mediaUrls: post.media_urls,
          accountExternalId: null,
        });

        if (result.status === 'published') {
          await ctx.db.query(
            `update crm.social_posts
             set status = 'published', published_at = now(), external_post_id = $2, external_url = $3,
                 error = null, updated_at = now()
             where id = $1`,
            [post.id, result.externalPostId ?? null, result.externalUrl ?? null],
          );
          published.push(post.id);
        } else {
          // Deliberately left 'approved', not 'failed': there is no adapter yet,
          // so this is a missing capability rather than a rejected post. Marking
          // it failed would bury content that is ready to go out by hand.
          await ctx.db.query(`update crm.social_posts set error = $2, updated_at = now() where id = $1`, [
            post.id,
            result.error ?? 'publish failed',
          ]);
          failed.push({ post_id: post.id, error: result.error ?? 'publish failed' });
        }
      }

      return {
        result: jsonResult({
          status: published.length > 0 ? 'published' : 'nothing_published',
          published_count: published.length,
          failed_count: failed.length,
          failures: failed,
          note:
            failed.length > 0
              ? 'Failed posts remain approved and due, so they publish as soon as an adapter exists. ' +
                'Their copy is available via crm_list_social_posts.'
              : undefined,
        }),
        summary: `published ${published.length}, failed ${failed.length}`,
      };
    }),
  );

  server.registerTool(
    'crm_social_platform_rules',
    {
      title: 'Social platform rules',
      description:
        'Returns the per-platform limits the CRM enforces, and which publishing adapters are implemented.',
      inputSchema: {},
    },
    readTool(async () =>
      jsonResult({
        platforms: SOCIAL_PLATFORMS.map((p) => ({
          platform: p,
          ...PLATFORM_RULES[p],
          adapter_configured: ctx.socialAdapters[p].configured,
        })),
        note:
          'No publishing adapter is implemented yet. Drafting, validation, scheduling and approval all work; ' +
          'publishing is manual until a platform is wired up. See SOCIAL.md.',
      }),
    ),
  );
}
