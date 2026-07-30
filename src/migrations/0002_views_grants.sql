-- 0002_views_grants.sql
-- @optional  -- may be skipped when run as crm_service; see below.
--
-- The read-only contract between the app and the CRM (§4b) plus the event-bridge
-- grant (§4c). These objects live in `public`, which the APP team owns, so this
-- migration is expected to be run ONCE BY THE DATABASE OWNER -- not by the CRM.
--
-- When the CRM's migrator runs as `crm_service` it will not have rights to create
-- objects in `public`. That is not an error: the runner records this migration as
-- SKIPPED with a reason and carries on, then applies it for real the next time it
-- is run by an owner-level role. Nothing here ever ALTERs an app table.
--
-- The `@optional` marker above is what tells the runner that behaviour is allowed.

do $$
begin
  -- ---------------------------------------------------------------------
  -- Aggregate revenue/subscription signal. No message content, no PII beyond
  -- the opaque RevenueCat/Clerk id the CRM already correlates on.
  -- ---------------------------------------------------------------------
  if to_regclass('public.subscriptions') is not null then
    execute $v$
      create or replace view public.crm_v_subscriptions as
        select rc_app_user_id, status, started_at, current_period_end, plan
        from public.subscriptions
    $v$;
  else
    raise notice 'public.subscriptions not found - skipping crm_v_subscriptions. The app team creates this view (§4b).';
  end if;

  -- ---------------------------------------------------------------------
  -- Referral performance, aggregated by code so no individual referee rows leak.
  -- ---------------------------------------------------------------------
  if to_regclass('public.referrals') is not null then
    execute $v$
      create or replace view public.crm_v_referrals as
        select referrer_code,
               count(*) filter (where rewarded_at is not null) as converted,
               count(*)                                        as total
        from public.referrals
        group by referrer_code
    $v$;
  else
    raise notice 'public.referrals not found - skipping crm_v_referrals. The app team creates this view (§4b).';
  end if;
end $$;

-- Grants: SELECT on the contract views only. The CRM never selects from raw
-- public.users / public.interactions / etc.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'crm_service') then
    if to_regclass('public.crm_v_subscriptions') is not null then
      execute 'grant usage on schema public to crm_service';
      execute 'grant select on public.crm_v_subscriptions to crm_service';
    end if;
    if to_regclass('public.crm_v_referrals') is not null then
      execute 'grant usage on schema public to crm_service';
      execute 'grant select on public.crm_v_referrals to crm_service';
    end if;
  else
    raise notice 'role crm_service does not exist - run the §4a role SQL first.';
  end if;
end $$;

-- Event bridge (§4c): the app's backend role gets INSERT on the landing table
-- and nothing else in `crm`. If you would rather grant the app no `crm` access
-- at all, skip this and have the app POST /crm/ingest instead.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_backend_role') then
    execute 'grant usage on schema crm to app_backend_role';
    execute 'grant insert on crm.events_inbox to app_backend_role';
    execute 'grant usage, select on sequence crm.events_inbox_id_seq to app_backend_role';

    -- The grant alone is not enough. RLS is enabled on every crm table and the
    -- table owner (crm_service) bypasses it, but app_backend_role does not --
    -- with no policy it would be denied despite holding INSERT. This policy is
    -- the one hole in the deny-by-default posture, and it is insert-only on the
    -- landing table: the app can drop facts in, and can read nothing back out.
    if not exists (
      select 1 from pg_policies
      where schemaname = 'crm' and tablename = 'events_inbox' and policyname = 'app_backend_can_insert'
    ) then
      execute 'create policy app_backend_can_insert on crm.events_inbox
                 for insert to app_backend_role with check (true)';
    end if;
  else
    raise notice 'role app_backend_role does not exist - grant the event-bridge INSERT to whatever role your app backend uses.';
  end if;
end $$;
