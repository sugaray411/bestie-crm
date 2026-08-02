-- 0001_crm_schema.sql
-- Owns: the `crm` schema and everything inside it. Touches NOTHING in `public`.
-- Safe to run repeatedly (idempotent).
--
-- Ownership contract: the app team owns `public` app tables and the definitions of
-- the `public.crm_v_*` contract views. This project owns everything in `crm`.

-- Both of these are normally done once by the DB owner (§4a) before the CRM ever
-- connects. They are guarded rather than written as `create ... if not exists`
-- because CREATE SCHEMA and CREATE EXTENSION check privileges BEFORE the
-- if-not-exists test: unguarded, they fail with "permission denied for database"
-- when run as crm_service even though there is nothing left to create.
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'crm') then
    execute 'create schema crm';
  end if;
end $$;

-- The app already enables pgcrypto; we reuse it rather than requiring rights to it.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    execute 'create extension pgcrypto';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Migration history. Deliberately separate from the app's own history so the
-- two migration tools never read or write each other's state.
-- ---------------------------------------------------------------------------
create table if not exists crm.migrations (
  id           text primary key,
  checksum     text        not null,
  applied_at   timestamptz not null default now(),
  skipped      boolean     not null default false,
  skip_reason  text
);

-- ---------------------------------------------------------------------------
-- Contacts
--
-- PII note (§7.9): email/phone are stored in plaintext because they are the
-- delivery addresses -- a one-way hash cannot be sent to. They are protected by
-- (a) Supabase volume encryption at rest, (b) the least-privilege `crm_service`
-- role, (c) RLS denying PostgREST roles entirely, and (d) redaction in
-- crm.audit_log. Never copy these columns into logs or tool results wholesale.
-- ---------------------------------------------------------------------------
create table if not exists crm.contacts (
  id               uuid primary key default gen_random_uuid(),
  email            text,
  phone            text,
  push_token       text,
  name             text,
  source           text,
  locale           text,
  country          text,
  timezone         text,
  tags             text[] not null default '{}',
  lifecycle_stage  text   not null default 'lead'
                     check (lifecycle_stage in ('lead','trial','active','churned')),
  rc_app_user_id   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint contacts_has_an_address check (
    email is not null or phone is not null or push_token is not null
  )
);

create unique index if not exists contacts_email_key
  on crm.contacts (lower(email)) where email is not null;
create unique index if not exists contacts_phone_key
  on crm.contacts (phone) where phone is not null;
create index if not exists contacts_rc_app_user_id_idx
  on crm.contacts (rc_app_user_id) where rc_app_user_id is not null;
create index if not exists contacts_lifecycle_stage_idx on crm.contacts (lifecycle_stage);
create index if not exists contacts_tags_idx on crm.contacts using gin (tags);

-- ---------------------------------------------------------------------------
-- Consent. Append-only: the latest row per (contact, channel) is authoritative,
-- and history is retained as the audit trail regulators ask for.
-- ---------------------------------------------------------------------------
create table if not exists crm.consents (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references crm.contacts(id) on delete cascade,
  channel     text not null check (channel in ('email','sms','push')),
  status      text not null check (status in ('granted','revoked')),
  basis       text not null check (basis in ('opt_in','referral','existing_customer')),
  source      text,
  ip          text,
  ts          timestamptz not null default now()
);

create index if not exists consents_lookup_idx
  on crm.consents (contact_id, channel, ts desc);

-- ---------------------------------------------------------------------------
-- Suppression. Absolute: a value here is never messaged, whatever consent says.
-- ---------------------------------------------------------------------------
create table if not exists crm.suppression (
  id          uuid primary key default gen_random_uuid(),
  channel     text not null check (channel in ('email','sms','push')),
  value       text not null,
  reason      text not null check (reason in ('unsubscribe','bounce','complaint','manual')),
  created_at  timestamptz not null default now()
);

create unique index if not exists suppression_channel_value_key
  on crm.suppression (channel, lower(value));

-- ---------------------------------------------------------------------------
-- Segments. `definition` is a safe filter AST -- never raw SQL. It is compiled
-- to a parameterized query by src/core/segmentAst.ts.
-- ---------------------------------------------------------------------------
create table if not exists crm.segments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  definition  jsonb not null,
  created_at  timestamptz not null default now()
);

create table if not exists crm.templates (
  id          uuid primary key default gen_random_uuid(),
  channel     text not null check (channel in ('email','sms','push')),
  name        text not null unique,
  subject     text,
  body        text not null,
  variables   text[] not null default '{}',
  created_at  timestamptz not null default now()
);

create table if not exists crm.campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  channel       text not null check (channel in ('email','sms','push')),
  template_id   uuid references crm.templates(id) on delete restrict,
  segment_id    uuid references crm.segments(id) on delete restrict,
  status        text not null default 'draft'
                  check (status in ('draft','scheduled','sending','paused','sent','failed')),
  scheduled_at  timestamptz,
  dry_run       boolean not null default true,
  pause_reason  text,
  created_by    text,
  created_at    timestamptz not null default now()
);

create index if not exists campaigns_status_idx on crm.campaigns (status);

create table if not exists crm.messages (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid references crm.campaigns(id) on delete set null,
  contact_id   uuid references crm.contacts(id) on delete cascade,
  channel      text not null check (channel in ('email','sms','push')),
  status       text not null check (status in (
                 'queued','sent','delivered','opened','clicked','bounced','failed',
                 'skipped_no_consent','skipped_suppressed','skipped_quiet_hours',
                 'skipped_frequency_cap','skipped_rate_limit','skipped_no_address',
                 'skipped_region_requires_opt_in')),
  provider_id  text,
  error        text,
  cost_usd     numeric(10,5) not null default 0,
  sent_at      timestamptz not null default now()
);

create index if not exists messages_campaign_idx on crm.messages (campaign_id);
-- Drives the rolling-window frequency cap, so keep it selective.
create index if not exists messages_contact_sent_idx on crm.messages (contact_id, sent_at desc);

create table if not exists crm.events (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid references crm.contacts(id) on delete cascade,
  type        text not null check (type in (
                'visit','signup','trial_start','subscribe','cancel','open','click',
                'referral_sent','referral_converted','video_call_used','chat_used')),
  value       numeric,
  meta        jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists events_type_occurred_idx on crm.events (type, occurred_at desc);
create index if not exists events_contact_idx on crm.events (contact_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Event bridge landing table (§4c). The app backend has INSERT here and
-- nothing else in `crm`; a worker drains it into crm.events.
-- ---------------------------------------------------------------------------
create table if not exists crm.events_inbox (
  id           bigserial primary key,
  type         text not null,
  contact_ref  jsonb not null default '{}'::jsonb,
  value        numeric,
  meta         jsonb not null default '{}'::jsonb,
  source       text,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text
);

create index if not exists events_inbox_unprocessed_idx
  on crm.events_inbox (received_at) where processed_at is null;

create table if not exists crm.audit_log (
  id              uuid primary key default gen_random_uuid(),
  actor           text,
  tool            text not null,
  args_redacted   jsonb not null default '{}'::jsonb,
  result_summary  text,
  created_at      timestamptz not null default now()
);

create index if not exists audit_log_tool_created_idx on crm.audit_log (tool, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: deny PostgREST roles (anon/authenticated) outright. The CRM connects as
-- a real database role that owns these tables, so it is not blocked.
--
-- Note we deliberately do NOT `force row level security`: forcing it would also
-- apply to the owner, and with zero policies defined that would lock the CRM
-- out of its own tables. Enable + no policies + no grants to anon is the
-- deny-by-default posture we want.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'contacts','consents','suppression','segments','templates','campaigns',
    'messages','events','events_inbox','audit_log','migrations'
  ] loop
    execute format('alter table crm.%I enable row level security', t);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema crm from anon';
    execute 'revoke usage on schema crm from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema crm from authenticated';
    execute 'revoke usage on schema crm from authenticated';
  end if;
end $$;
