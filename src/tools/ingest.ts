import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../context.js';
import { auditedTool, jsonResult, readTool } from './helpers.js';
import { findContact, insertEvent, upsertContact } from '../db/repo.js';
import { checkIsolation } from '../db/isolation.js';
import { EVENT_TYPES, type EventType } from '../types.js';

/**
 * The event bridge (§4c). The app backend emits facts -- signup, trial_start,
 * subscribe, cancel, and optionally video_call_used / chat_used -- either by
 * inserting into crm.events_inbox (its only permission inside `crm`) or by
 * POSTing to /crm/ingest. The CRM interprets them. No shared code, no shared
 * library version to keep in step.
 */

export const ContactRefSchema = z.object({
  contact_id: z.string().uuid().optional(),
  rc_app_user_id: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  name: z.string().optional(),
  country: z.string().length(2).optional(),
  timezone: z.string().optional(),
  source: z.string().optional(),
});

export type ContactRef = z.infer<typeof ContactRefSchema>;

export interface IngestInput {
  type: EventType;
  contact_ref?: ContactRef;
  value?: number | null;
  meta?: Record<string, unknown>;
  occurred_at?: string | null;
}

export interface IngestResult {
  event_id: string;
  contact_id: string | null;
  contact_created: boolean;
}

/**
 * Upserts the contact and appends the event.
 *
 * Note what this does NOT do: it never records consent. A product event means
 * the person used the app, not that they agreed to be marketed to. Contacts
 * that arrive this way are messageable only once a real opt-in is recorded --
 * which is what keeps Bestie's zero-collection promise intact (§11).
 */
export async function ingestEvent(ctx: ServerContext, input: IngestInput): Promise<IngestResult> {
  let contactId: string | null = null;
  let created = false;

  const ref = input.contact_ref;
  if (ref && (ref.contact_id || ref.rc_app_user_id || ref.email || ref.phone)) {
    if (ref.contact_id) {
      const existing = await findContact(ctx.db, { id: ref.contact_id });
      contactId = existing?.id ?? null;
    }
    if (!contactId) {
      const { contact, created: didCreate } = await upsertContact(ctx.db, {
        rc_app_user_id: ref.rc_app_user_id ?? null,
        email: ref.email ?? null,
        phone: ref.phone ?? null,
        name: ref.name ?? null,
        country: ref.country ?? null,
        timezone: ref.timezone ?? null,
        source: ref.source ?? 'app',
        lifecycle_stage: lifecycleFor(input.type),
      });
      contactId = contact.id;
      created = didCreate;
    }
  }

  const eventId = await insertEvent(ctx.db, {
    contact_id: contactId,
    type: input.type,
    value: input.value ?? null,
    meta: input.meta ?? {},
    occurred_at: input.occurred_at ?? null,
  });

  return { event_id: eventId, contact_id: contactId, contact_created: created };
}

/** Product events carry lifecycle meaning; keep the contact's stage in step. */
function lifecycleFor(type: EventType): 'lead' | 'trial' | 'active' | 'churned' | undefined {
  switch (type) {
    case 'signup':
      return 'lead';
    case 'trial_start':
      return 'trial';
    case 'subscribe':
      return 'active';
    case 'cancel':
      return 'churned';
    default:
      return undefined;
  }
}

export interface DrainResult {
  processed: number;
  failed: number;
  errors: string[];
}

/**
 * Drains crm.events_inbox into crm.events. Rows are claimed with
 * `for update skip locked` so two workers (or a worker and an HTTP request)
 * never process the same row twice.
 */
export async function drainEventsInbox(ctx: ServerContext, limit = 500): Promise<DrainResult> {
  const result: DrainResult = { processed: 0, failed: 0, errors: [] };

  const client = await ctx.db.connect();
  let rows: Array<{
    id: string;
    type: string;
    contact_ref: unknown;
    value: string | null;
    meta: Record<string, unknown>;
    received_at: string;
  }>;
  try {
    await client.query('begin');
    const claimed = await client.query(
      `select id, type, contact_ref, value, meta, received_at from crm.events_inbox
       where processed_at is null
       order by received_at asc
       limit $1
       for update skip locked`,
      [limit],
    );
    rows = claimed.rows;
    // Mark claimed rows immediately; a failure below records the error on the
    // row rather than leaving it to be retried forever.
    if (rows.length > 0) {
      await client.query(`update crm.events_inbox set processed_at = now() where id = any($1::bigint[])`, [
        rows.map((r) => r.id),
      ]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  for (const row of rows) {
    try {
      if (!(EVENT_TYPES as readonly string[]).includes(row.type)) {
        throw new Error(`Unknown event type "${row.type}".`);
      }
      const ref = ContactRefSchema.safeParse(row.contact_ref ?? {});
      await ingestEvent(ctx, {
        type: row.type as EventType,
        contact_ref: ref.success ? ref.data : undefined,
        value: row.value === null ? null : Number(row.value),
        meta: row.meta ?? {},
        occurred_at: row.received_at,
      });
      result.processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed += 1;
      if (result.errors.length < 10) result.errors.push(`inbox ${row.id}: ${message}`);
      await ctx.db
        .query(`update crm.events_inbox set error = $2 where id = $1`, [row.id, message.slice(0, 500)])
        .catch(() => undefined);
    }
  }

  return result;
}

export function registerIngestTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'crm_ingest_event',
    {
      title: 'Ingest a growth event',
      description:
        'Records a product event (signup, trial_start, subscribe, cancel, video_call_used, chat_used, ...) ' +
        'and upserts the contact it belongs to. This is what the funnel is built from. Recording an event ' +
        'never grants marketing consent.',
      inputSchema: {
        type: z.enum(EVENT_TYPES),
        contact_ref: ContactRefSchema.optional().describe('How to find or create the contact this event belongs to'),
        value: z.number().optional().describe('Revenue or duration, depending on the event type'),
        meta: z.record(z.unknown()).optional(),
        occurred_at: z.string().datetime().optional(),
      },
    },
    auditedTool(ctx, 'crm_ingest_event', async (args) => {
      const result = await ingestEvent(ctx, {
        type: args.type,
        contact_ref: args.contact_ref,
        value: args.value ?? null,
        meta: args.meta ?? {},
        occurred_at: args.occurred_at ?? null,
      });
      return {
        result: jsonResult(result),
        summary: `ingested ${args.type} event${result.contact_created ? ' (new contact)' : ''}`,
      };
    }),
  );

  server.registerTool(
    'crm_drain_events_inbox',
    {
      title: 'Drain the event inbox',
      description:
        'Folds rows the app backend inserted into crm.events_inbox through to crm.events, upserting contacts ' +
        'as it goes. Safe to run repeatedly and safe to run concurrently.',
      inputSchema: { limit: z.number().int().min(1).max(5000).default(500) },
    },
    auditedTool(ctx, 'crm_drain_events_inbox', async (args) => {
      const result = await drainEventsInbox(ctx, args.limit ?? 500);
      return {
        result: jsonResult(result),
        summary: `drained ${result.processed} inbox rows (${result.failed} failed)`,
      };
    }),
  );

  server.registerTool(
    'crm_check_isolation',
    {
      title: 'Check database isolation',
      description:
        'Verifies the least-privilege contract: the CRM can read and write its own `crm` schema, cannot ' +
        'select from raw app tables, and can read the crm_v_* contract views.',
      inputSchema: {},
    },
    readTool(async () => jsonResult(await checkIsolation(ctx.db))),
  );
}
