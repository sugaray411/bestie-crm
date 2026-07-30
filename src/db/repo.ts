import type { Db } from './pool.js';
import { num } from './pool.js';
import type {
  Campaign,
  Channel,
  Contact,
  ConsentBasis,
  ConsentRecord,
  ConsentStatus,
  EventType,
  LifecycleStage,
  MessageStatus,
  SuppressionReason,
  Template,
} from '../types.js';

/** Query helpers shared by the tools. Everything here is parameterized. */

const CONTACT_COLUMNS = `id, email, phone, push_token, name, source, locale, country, timezone,
  tags, lifecycle_stage, rc_app_user_id, created_at, updated_at`;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** E.164-ish: keep a leading +, strip formatting. Rejects nothing -- validation is zod's job. */
export const normalizePhone = (phone: string): string => {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
};

export interface ContactInput {
  email?: string | null;
  phone?: string | null;
  push_token?: string | null;
  name?: string | null;
  source?: string | null;
  locale?: string | null;
  country?: string | null;
  timezone?: string | null;
  tags?: string[];
  lifecycle_stage?: LifecycleStage;
  rc_app_user_id?: string | null;
}

export async function createContact(db: Db, input: ContactInput): Promise<Contact> {
  const { rows } = await db.query<Contact>(
    `insert into crm.contacts
       (email, phone, push_token, name, source, locale, country, timezone, tags, lifecycle_stage, rc_app_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::text[],'{}'::text[]),coalesce($10::text,'lead'),$11)
     returning ${CONTACT_COLUMNS}`,
    [
      input.email ? normalizeEmail(input.email) : null,
      input.phone ? normalizePhone(input.phone) : null,
      input.push_token ?? null,
      input.name ?? null,
      input.source ?? null,
      input.locale ?? null,
      input.country ? input.country.toUpperCase() : null,
      input.timezone ?? null,
      input.tags ?? null,
      input.lifecycle_stage ?? null,
      input.rc_app_user_id ?? null,
    ],
  );
  return rows[0]!;
}

/**
 * Upsert keyed on whichever identifier we have, preferring the stable app id.
 * Used by the event bridge, where the same person arrives repeatedly.
 */
export async function upsertContact(db: Db, input: ContactInput): Promise<{ contact: Contact; created: boolean }> {
  const existing = await findContact(db, {
    rc_app_user_id: input.rc_app_user_id ?? undefined,
    email: input.email ?? undefined,
    phone: input.phone ?? undefined,
  });
  if (existing) {
    const updated = await updateContact(db, existing.id, input);
    return { contact: updated ?? existing, created: false };
  }
  return { contact: await createContact(db, input), created: true };
}

export async function findContact(
  db: Db,
  by: { id?: string; email?: string; phone?: string; rc_app_user_id?: string },
): Promise<Contact | null> {
  if (by.id) {
    const { rows } = await db.query<Contact>(
      `select ${CONTACT_COLUMNS} from crm.contacts where id = $1`,
      [by.id],
    );
    if (rows[0]) return rows[0];
  }
  if (by.rc_app_user_id) {
    const { rows } = await db.query<Contact>(
      `select ${CONTACT_COLUMNS} from crm.contacts where rc_app_user_id = $1 limit 1`,
      [by.rc_app_user_id],
    );
    if (rows[0]) return rows[0];
  }
  if (by.email) {
    const { rows } = await db.query<Contact>(
      `select ${CONTACT_COLUMNS} from crm.contacts where lower(email) = $1 limit 1`,
      [normalizeEmail(by.email)],
    );
    if (rows[0]) return rows[0];
  }
  if (by.phone) {
    const { rows } = await db.query<Contact>(
      `select ${CONTACT_COLUMNS} from crm.contacts where phone = $1 limit 1`,
      [normalizePhone(by.phone)],
    );
    if (rows[0]) return rows[0];
  }
  return null;
}

const UPDATABLE: Array<keyof ContactInput> = [
  'email', 'phone', 'push_token', 'name', 'source', 'locale', 'country',
  'timezone', 'tags', 'lifecycle_stage', 'rc_app_user_id',
];

export async function updateContact(db: Db, id: string, input: ContactInput): Promise<Contact | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of UPDATABLE) {
    const value = input[key];
    if (value === undefined) continue;
    let normalized: unknown = value;
    if (key === 'email' && typeof value === 'string') normalized = normalizeEmail(value);
    if (key === 'phone' && typeof value === 'string') normalized = normalizePhone(value);
    if (key === 'country' && typeof value === 'string') normalized = value.toUpperCase();
    values.push(normalized);
    sets.push(`${key} = $${values.length}`);
  }
  if (sets.length === 0) return findContact(db, { id });
  values.push(id);
  const { rows } = await db.query<Contact>(
    `update crm.contacts set ${sets.join(', ')}, updated_at = now()
     where id = $${values.length} returning ${CONTACT_COLUMNS}`,
    values,
  );
  return rows[0] ?? null;
}

export async function searchContacts(
  db: Db,
  opts: { q?: string; lifecycle_stage?: LifecycleStage; tag?: string; limit: number },
): Promise<Contact[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (opts.q) {
    values.push(`%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    clauses.push(`(email ilike $${values.length} or name ilike $${values.length} or phone ilike $${values.length})`);
  }
  if (opts.lifecycle_stage) {
    values.push(opts.lifecycle_stage);
    clauses.push(`lifecycle_stage = $${values.length}`);
  }
  if (opts.tag) {
    values.push([opts.tag]);
    clauses.push(`tags @> $${values.length}::text[]`);
  }
  values.push(opts.limit);
  const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
  const { rows } = await db.query<Contact>(
    `select ${CONTACT_COLUMNS} from crm.contacts ${where} order by created_at desc limit $${values.length}`,
    values,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export async function recordConsent(
  db: Db,
  input: {
    contact_id: string;
    channel: Channel;
    status: ConsentStatus;
    basis: ConsentBasis;
    source?: string | null;
    ip?: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into crm.consents (contact_id, channel, status, basis, source, ip)
     values ($1,$2,$3,$4,$5,$6)`,
    [input.contact_id, input.channel, input.status, input.basis, input.source ?? null, input.ip ?? null],
  );
}

export async function consentsFor(db: Db, contactId: string): Promise<ConsentRecord[]> {
  const { rows } = await db.query<ConsentRecord>(
    `select channel, status, basis, ts from crm.consents where contact_id = $1 order by ts asc`,
    [contactId],
  );
  return rows;
}

/** One round trip for a whole batch -- the per-contact version would be N+1. */
export async function consentsForMany(
  db: Db,
  contactIds: readonly string[],
): Promise<Map<string, ConsentRecord[]>> {
  const out = new Map<string, ConsentRecord[]>();
  if (contactIds.length === 0) return out;
  const { rows } = await db.query<ConsentRecord & { contact_id: string }>(
    `select contact_id, channel, status, basis, ts from crm.consents
     where contact_id = any($1::uuid[]) order by ts asc`,
    [contactIds],
  );
  for (const row of rows) {
    const list = out.get(row.contact_id) ?? [];
    list.push({ channel: row.channel, status: row.status, basis: row.basis, ts: row.ts });
    out.set(row.contact_id, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

export async function addSuppression(
  db: Db,
  input: { channel: Channel; value: string; reason: SuppressionReason },
): Promise<void> {
  const value = input.channel === 'email' ? normalizeEmail(input.value) : input.value.trim();
  await db.query(
    `insert into crm.suppression (channel, value, reason) values ($1,$2,$3)
     on conflict (channel, lower(value)) do nothing`,
    [input.channel, value, input.reason],
  );
}

export async function isSuppressed(db: Db, channel: Channel, value: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from crm.suppression where channel = $1 and lower(value) = lower($2) limit 1`,
    [channel, value],
  );
  return rows.length > 0;
}

export async function suppressedSet(
  db: Db,
  channel: Channel,
  values: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (values.length === 0) return out;
  const { rows } = await db.query<{ value: string }>(
    `select lower(value) as value from crm.suppression
     where channel = $1 and lower(value) = any($2::text[])`,
    [channel, values.map((v) => v.toLowerCase())],
  );
  for (const row of rows) out.add(row.value);
  return out;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function recentMessageCounts(
  db: Db,
  contactIds: readonly string[],
  windowDays: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (contactIds.length === 0) return out;
  const { rows } = await db.query<{ contact_id: string; count: string }>(
    `select contact_id, count(*) as count from crm.messages
     where contact_id = any($1::uuid[])
       and status in ('sent','delivered','opened','clicked','queued')
       and sent_at > now() - ($2::int * interval '1 day')
     group by contact_id`,
    [contactIds, windowDays],
  );
  for (const row of rows) out.set(row.contact_id, num(row.count));
  return out;
}

export async function insertMessage(
  db: Db,
  input: {
    campaign_id?: string | null;
    contact_id: string;
    channel: Channel;
    status: MessageStatus;
    provider_id?: string | null;
    error?: string | null;
    cost_usd?: number;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into crm.messages (campaign_id, contact_id, channel, status, provider_id, error, cost_usd)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      input.campaign_id ?? null,
      input.contact_id,
      input.channel,
      input.status,
      input.provider_id ?? null,
      input.error ?? null,
      input.cost_usd ?? 0,
    ],
  );
  return rows[0]!.id;
}

export async function spentTodayUsd(db: Db): Promise<number> {
  const { rows } = await db.query<{ total: string }>(
    `select coalesce(sum(cost_usd),0) as total from crm.messages where sent_at >= date_trunc('day', now())`,
  );
  return num(rows[0]?.total);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function insertEvent(
  db: Db,
  input: {
    contact_id?: string | null;
    type: EventType;
    value?: number | null;
    meta?: Record<string, unknown>;
    occurred_at?: string | null;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into crm.events (contact_id, type, value, meta, occurred_at)
     values ($1,$2,$3,$4::jsonb,coalesce($5::timestamptz, now())) returning id`,
    [
      input.contact_id ?? null,
      input.type,
      input.value ?? null,
      JSON.stringify(input.meta ?? {}),
      input.occurred_at ?? null,
    ],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Templates, segments, campaigns
// ---------------------------------------------------------------------------

export async function getTemplate(db: Db, idOrName: string): Promise<Template | null> {
  const { rows } = await db.query<Template>(
    `select id, channel, name, subject, body, variables, created_at from crm.templates
     where name = $1 or id::text = $1 limit 1`,
    [idOrName],
  );
  return rows[0] ?? null;
}

export async function getSegment(
  db: Db,
  idOrName: string,
): Promise<{ id: string; name: string; definition: unknown } | null> {
  const { rows } = await db.query<{ id: string; name: string; definition: unknown }>(
    `select id, name, definition from crm.segments where name = $1 or id::text = $1 limit 1`,
    [idOrName],
  );
  return rows[0] ?? null;
}

export async function getCampaign(db: Db, idOrName: string): Promise<Campaign | null> {
  const { rows } = await db.query<Campaign>(
    `select id, name, channel, template_id, segment_id, status, scheduled_at, dry_run,
            pause_reason, created_by, created_at
     from crm.campaigns where name = $1 or id::text = $1 limit 1`,
    [idOrName],
  );
  return rows[0] ?? null;
}

export async function setCampaignStatus(
  db: Db,
  id: string,
  status: Campaign['status'],
  pauseReason?: string | null,
): Promise<void> {
  await db.query(`update crm.campaigns set status = $2, pause_reason = $3 where id = $1`, [
    id,
    status,
    pauseReason ?? null,
  ]);
}
