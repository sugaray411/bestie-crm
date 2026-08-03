-- 0003_social_content.sql
-- Social content drafting, scheduling and publishing. Lives entirely in `crm`,
-- like everything else this project owns.
--
-- Deliberately separate from crm.campaigns: a campaign messages identified
-- people and is governed by consent, suppression and quiet hours. A social post
-- is a broadcast to whoever follows the account -- none of those gates apply,
-- and pretending they do would be theatre. What DOES carry over is the
-- truthfulness rule: a false claim is a false claim wherever it is published.

create table if not exists crm.social_accounts (
  id            uuid primary key default gen_random_uuid(),
  platform      text not null check (platform in
                  ('x','instagram','tiktok','linkedin','facebook','threads','youtube')),
  handle        text not null,
  display_name  text,
  -- The platform's own identifier for the account, once connected.
  external_id   text,
  status        text not null default 'active' check (status in ('active','disconnected')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists social_accounts_platform_handle_key
  on crm.social_accounts (platform, lower(handle));

create table if not exists crm.social_posts (
  id               uuid primary key default gen_random_uuid(),
  -- Nullable: copy can be drafted before deciding which account posts it.
  account_id       uuid references crm.social_accounts(id) on delete set null,
  platform         text not null check (platform in
                     ('x','instagram','tiktok','linkedin','facebook','threads','youtube')),
  body             text not null,
  media_urls       text[] not null default '{}',
  status           text not null default 'draft' check (status in
                     ('draft','scheduled','approved','published','failed','cancelled')),
  scheduled_at     timestamptz,
  approved_by      text,
  approved_at      timestamptz,
  published_at     timestamptz,
  -- Set by the platform once the post actually exists there.
  external_post_id text,
  external_url     text,
  error            text,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Drives "what is due to publish", so keep it selective.
create index if not exists social_posts_due_idx
  on crm.social_posts (scheduled_at)
  where status = 'approved';
create index if not exists social_posts_status_idx on crm.social_posts (status);
create index if not exists social_posts_account_idx on crm.social_posts (account_id);

-- Same deny-by-default posture as every other crm table (see 0001): RLS on, no
-- policies, no grants to the PostgREST roles. Not forced, so the owning role
-- is not locked out of its own tables.
do $$
declare t text;
begin
  foreach t in array array['social_accounts','social_posts'] loop
    execute format('alter table crm.%I enable row level security', t);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on crm.social_accounts, crm.social_posts from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on crm.social_accounts, crm.social_posts from authenticated';
  end if;
end $$;
