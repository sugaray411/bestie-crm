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

-- A table can exist while carrying none of the columns this contract needs --
-- a half-built table from the dashboard editor is the usual cause. Checking
-- only `to_regclass` would let the CREATE VIEW run and fail on `undefined_column`
-- (42703), which is NOT the privilege error the runner tolerates for @optional:
-- it aborts the whole migration. So each view checks its columns first and
-- degrades to a notice, exactly as it does for a missing table.
-- Deliberately pg_catalog and not information_schema: information_schema.columns
-- shows only columns the CALLER holds privileges on. Read as `crm_service` --
-- which is revoked from `public` by design -- it returns nothing, the guard would
-- skip both views, and 0002 would be recorded APPLIED instead of SKIPPED. The
-- owner pass would then report `already-applied` and never create the views.
-- pg_attribute is privilege-independent, so crm_service still reaches the
-- CREATE VIEW and still earns the privilege error the runner needs to see.
create or replace function pg_temp.crm_has_cols(tbl text, cols text[])
returns boolean language sql stable as $fn$
  select to_regclass(tbl) is not null
     and not exists (
           select 1 from unnest(cols) as needed(name)
           where not exists (
             select 1 from pg_attribute a
             where a.attrelid = to_regclass(tbl)
               and a.attname  = needed.name
               and a.attnum   > 0
               and not a.attisdropped
           )
         );
$fn$;

do $$
begin
  -- ---------------------------------------------------------------------
  -- Aggregate revenue/subscription signal. No message content, no PII beyond
  -- the opaque RevenueCat/Clerk id the CRM already correlates on.
  -- ---------------------------------------------------------------------
  -- The app's column names differ from the contract's, so the view aliases them
  -- (§1). The app table is never altered -- renaming its columns to suit the CRM
  -- would be the tail wagging the dog, and would break whatever already reads it.
  --   revenuecat_app_user_id -> rc_app_user_id
  --   created_at             -> started_at
  --   expires_at             -> current_period_end
  --   product_id             -> plan
  if pg_temp.crm_has_cols('public.subscriptions',
       array['revenuecat_app_user_id','status','created_at','expires_at','product_id']) then
    execute $v$
      create or replace view public.crm_v_subscriptions as
        select revenuecat_app_user_id as rc_app_user_id,
               status,
               created_at             as started_at,
               expires_at             as current_period_end,
               product_id             as plan
        from public.subscriptions
    $v$;
  else
    raise notice 'public.subscriptions missing or lacking the contract columns - skipping crm_v_subscriptions. The app team creates this view (§4b).';
  end if;

  -- ---------------------------------------------------------------------
  -- Referral performance, aggregated by code so no individual referee rows leak.
  -- ---------------------------------------------------------------------
  if pg_temp.crm_has_cols('public.referrals', array['referrer_code','rewarded_at']) then
    execute $v$
      create or replace view public.crm_v_referrals as
        select referrer_code,
               count(*) filter (where rewarded_at is not null) as converted,
               count(*)                                        as total
        from public.referrals
        group by referrer_code
    $v$;
  -- The real table names the column `code`, not `referrer_code`: it is the
  -- referrer's own code, written onto each redemption row by
  -- backend/services/referralService.ts. Same meaning, different name, so map it
  -- rather than asking the app team to migrate a live table.
  elsif pg_temp.crm_has_cols('public.referrals', array['code','rewarded_at']) then
    execute $v$
      create or replace view public.crm_v_referrals as
        select code as referrer_code,
               count(*) filter (where rewarded_at is not null) as converted,
               count(*)                                        as total
        from public.referrals
        group by code
    $v$;
  else
    raise notice 'public.referrals missing or lacking the contract columns - skipping crm_v_referrals. The app team creates this view (§4b).';
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
