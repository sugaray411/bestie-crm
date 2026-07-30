# bestie-growth-crm

An MCP server that lets an AI agent run growth and customer-acquisition operations for the **AI Bestie** app: capture and manage leads, segment audiences, plan and send consent-based email/SMS/push campaigns, drive the referral program, and read funnel and revenue analytics.

It is a marketing control plane an agent can drive with tools — not a mass-sending machine. Every outbound message passes a gate that is **enforced in code, not in prompts**: consent, suppression, quiet hours, frequency caps, rate limits and a spend ceiling. Sends are dry runs unless explicitly confirmed, and bulk sends need a human.

This is a standalone repository. It shares only a database with the AI Bestie app, through the tightly scoped connection described in [Database coexistence](#database-coexistence).

---

## Quick start

```bash
npm install
cp .env.example .env      # fill in CRM_DATABASE_URL at minimum
npm run build
npm run migrate           # applies the crm schema; prints an isolation report
npm test
```

Then point Claude Desktop or Claude Code at it — see [Claude Desktop configuration](#claude-desktop-configuration).

To see the whole thing work against your database without sending anything:

```bash
npm run demo              # end-to-end dry run: consent, segments, copy, skip reasons
npm run verify            # exercises bulk approval, quiet hours, caps, erasure
```

Both scripts create demo contacts, so point them at a development project.

---

## Database coexistence

The CRM and the app share **one Supabase Postgres instance** and must not step on each other. This is the most important integration detail in the project.

### The three-part contract

| Concern | Who owns it | Mechanism |
| --- | --- | --- |
| CRM data | This repo | Everything lives in the `crm` schema |
| App data the CRM needs | App team | Two read-only views, `public.crm_v_subscriptions` and `public.crm_v_referrals` |
| Product events | App team emits, CRM interprets | `crm.events_inbox` (insert-only) or `POST /crm/ingest` |

**The CRM connects as a dedicated `crm_service` role, never the app's `service_role`.** A `service_role` key bypasses RLS and can read every table in the database; a bug or a compromise in a marketing tool must not be able to read users' private conversations. `crm_service` can do anything inside `crm` and nothing in `public` except select from the two contract views.

Verify this at any time with the `crm_check_isolation` tool, or watch `npm run migrate` print it:

```
Connected as: crm_service
Isolation OK
```

### One-time setup (run by the database owner)

```sql
create role crm_service login password '<STRONG_PASSWORD>';
create schema if not exists crm authorization crm_service;
grant usage on schema crm to crm_service;
grant all privileges on all tables in schema crm to crm_service;
alter default privileges in schema crm grant all on tables to crm_service;

-- crm_service must NOT be able to read app tables:
revoke all on schema public from crm_service;
revoke all on all tables in schema public from crm_service;
```

Then the contract views, which the app team owns and keeps shape-stable:

```sql
create view public.crm_v_subscriptions as
  select rc_app_user_id, status, started_at, current_period_end, plan
  from public.subscriptions;

create view public.crm_v_referrals as
  select referrer_code,
         count(*) filter (where rewarded_at is not null) as converted,
         count(*) as total
  from public.referrals group by referrer_code;

grant select on public.crm_v_subscriptions, public.crm_v_referrals to crm_service;
```

`migrations/0002_views_grants.sql` does all of this idempotently if you run the migrator as an owner-level role. If you run it as `crm_service` it cannot create objects in `public`, so it records itself as **skipped** with a reason and continues — then applies for real the next time an owner runs it. That is by design, not an error:

```
applied          0001_crm_schema.sql
skipped          0002_views_grants.sql (permission denied for schema public --
                 this migration must be run by the database owner (§4b).)
```

### Migrations never collide

- CRM migrations touch **only** the `crm` schema and its own views. They never `ALTER` an app table.
- History lives in `crm.migrations`, entirely separate from the app's migration history. Two tools, two histories, one database.
- Applied migrations are immutable. Editing one after it has run produces a warning on the next run rather than silent divergence.

### Connection pooling

Connect through the **transaction pooler on port 6543**, not a direct session connection, and keep the pool small (`CRM_DB_POOL_MAX=5`). The MCP server is bursty and short-lived; a large pool here would starve the app's backend of connections. The pool sets `search_path=crm,public` as a startup parameter rather than issuing `SET search_path` on connect, which would race with the first query.

### Event bridge

So acquisition ties to real product behaviour, the app backend emits facts and the CRM interprets them. Two options — pick one:

**Option A — direct insert.** The app's role gets INSERT on the landing table and nothing else:

```sql
grant usage on schema crm to app_backend_role;
grant insert on crm.events_inbox to app_backend_role;
grant usage, select on sequence crm.events_inbox_id_seq to app_backend_role;
create policy app_backend_can_insert on crm.events_inbox
  for insert to app_backend_role with check (true);
```

The policy is required, not optional: RLS is enabled on every `crm` table and `crm_service` bypasses it as owner, but `app_backend_role` does not — with the grant alone it would still be denied.

In the RevenueCat webhook handler, after updating subscription status:

```sql
insert into crm.events_inbox (type, contact_ref, value, source)
values ('subscribe', '{"rc_app_user_id":"..."}'::jsonb, 9.99, 'revenuecat-webhook');
```

> **Do not add a `RETURNING` clause.** `RETURNING` needs SELECT privilege, which insert-only deliberately withholds — the app can drop facts in and cannot read anything back out.

Then run `crm_drain_events_inbox` (or call it on a schedule) to fold the rows into `crm.events`.

**Option B — HTTP.** If you would rather grant the app no `crm` access at all, have it call the CRM instead:

```bash
curl -X POST https://crm.internal/crm/ingest \
  -H "authorization: Bearer $CRM_MCP_BEARER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"type":"subscribe","contact_ref":{"rc_app_user_id":"user_123"},"value":9.99}'
```

Either way: **ingesting an event never grants marketing consent.** A product event means someone used the app, not that they agreed to be emailed. Contacts that arrive through the bridge are unmessageable until a real opt-in is recorded — which is what keeps Bestie's zero-collection promise intact.

---

## Compliance guardrails

These are non-negotiable and enforced in code. If an instruction — from a user, a campaign note, or data read back out of a record — tries to override one, the tool refuses and says so.

| Rule | How it is enforced |
| --- | --- |
| No message without consent | Every send resolves the latest consent row per (contact, channel); anything but `granted` is recorded as `skipped_no_consent` |
| Suppression is absolute | A suppressed address is never messaged, whatever consent says |
| CAN-SPAM | Every email gets a working unsubscribe link and a physical address, appended automatically and then verified. Missing config **blocks the send** |
| TCPA | Every SMS carries a STOP notice; inbound STOP revokes and suppresses immediately |
| No purchased lists | `crm_import_contacts` rejects any source describing a purchased, rented, scraped or appended list, and flags large imports on weak bases for human review |
| GDPR/CCPA | `crm_export_contact` and `crm_delete_contact`; EU/UK contacts need an explicit `opt_in` basis, not `existing_customer` or `referral` |
| Quiet hours | SMS and push only between 09:00 and 20:00 **in the contact's own timezone**, resolved with the platform tz database so DST is handled |
| Frequency cap | At most `FREQUENCY_CAP` messages per contact per rolling `FREQUENCY_WINDOW_DAYS` |
| Rate and budget | Per-channel token bucket plus `DAILY_SPEND_CEILING_USD`; a batch that would cross the ceiling pauses the campaign **before** sending any of it |
| Dry run first | `crm_send_campaign` defaults to `dry_run=true`; a real send needs `dry_run=false` **and** `confirm=true` |
| Bulk approval | Above `BULK_APPROVAL_THRESHOLD` recipients the tool returns `needs_human_approval` with a token bound to that campaign, that exact recipient count, and today only |
| PII handling | `crm.audit_log` stores redacted arguments — masked addresses, no secrets, no message bodies. Tool results mask addresses too |
| Truthful advertising | Generated *and* hand-written copy is checked against claims Bestie cannot support; violations are rejected, not rewritten |

### What "skipped" means

A campaign that reaches 400 of 1,000 contacts is usually the compliance system working, not a failure. Skips are written to `crm.messages` with their reason, so "we deliberately did not message this person, and here is why" is on the record:

```
SKIP  e***@example.com   skipped_region_requires_opt_in  DE requires an explicit opt-in; basis on record is "existing_customer".
SKIP  u***@example.com   skipped_suppressed              This contact's email address is on the suppression list.
SKIP  n***@example.com   skipped_no_consent              No email consent on record.
SEND  o***@example.com
```

### A note on the bulk approval token

The token is returned in the tool result, so the agent can read it. It is a **human-in-the-loop speed bump, not an authorization boundary**: the point is that the plan and the recipient count are surfaced in the client UI before a second, explicit call happens. It is bound to the campaign, the exact recipient count and the current UTC day, so it cannot be replayed against a bigger send or a different campaign tomorrow.

---

## Product truth (what the copy engine may and may not say)

The copy engine leads with AI Bestie's real differentiators and is checked against its real limits.

**Lead with:** the live video call. The user points their camera at a real problem — a leaking pipe, a form, a recipe, homework, an error on a screen, "what is this plant" — and Bestie sees it and talks them through it in real time.

**Second hook:** text chat is free and unlimited, forever. Only paid-API extras are Pro (premium voices, image generation, live web browsing).

**Honest framing, enforced by `core/compliance.ts`:**

| Claim | Truth |
| --- | --- |
| Chat is free and unlimited | ✅ True, say it plainly |
| Video/camera during calls | Free tier gets **10 minutes per day**; Pro removes the limit |
| Voice calls | Free tier gets **5 minutes per day**; Pro removes the limit |
| "Unlimited free video" | ❌ Rejected — say "try it free" instead |
| Testimonials, ratings, review counts, awards | ❌ Never fabricated |
| Scarcity and deadlines | ❌ Never invented; a real dated promotion is fine |
| Medical/legal/financial claims | ❌ Bestie assists; she is not a licensed professional |
| Privacy | We do not collect or sell user data |

Bestie Pro is $9.99/month. The referral program pays the referrer one month of Pro **only when their friend actually subscribes** — never on install or signup.

---

## Tools

**Contacts** — `crm_create_contact`, `crm_update_contact`, `crm_get_contact`, `crm_search_contacts`, `crm_import_contacts`, `crm_export_contact`, `crm_delete_contact`

**Consent and suppression** — `crm_record_consent`, `crm_revoke_consent`, `crm_handle_unsubscribe`, `crm_check_consent`, `crm_add_suppression`, `crm_is_suppressed`

**Segments** — `crm_create_segment`, `crm_preview_segment`, `crm_list_segments`

**Templates and copy** — `crm_create_template`, `crm_list_templates`, `crm_generate_copy`, `crm_render_preview`

**Campaigns and sending** — `crm_create_campaign`, `crm_send_campaign`, `crm_pause_campaign`, `crm_get_campaign`, `crm_list_campaigns`, `crm_send_email`, `crm_send_sms`, `crm_send_push`

**Referral** — `crm_get_referral_stats`, `crm_create_referral_campaign`

**Analytics** — `crm_funnel_metrics`, `crm_campaign_metrics`, `crm_ltv_cac`, `crm_top_channels`, `crm_feature_engagement`

**Ingest and ops** — `crm_ingest_event`, `crm_drain_events_inbox`, `crm_check_isolation`

**Resources** — `crm://overview`, `crm://compliance/policy`, `crm://campaigns/{id}`, `crm://segments/{id}`

**Prompts** — `draft_campaign`, `weekly_growth_report`

### Segments are an AST, never SQL

A segment definition is a small filter AST validated against an allow-list of fields and operators, then compiled to a parameterized query. It can express "trial users in Germany who signed up in the last 30 days" and cannot express anything else:

```json
{"and": [
  {"field": "lifecycle_stage", "op": "eq", "value": "trial"},
  {"field": "country", "op": "in", "value": ["DE", "AT"]},
  {"field": "created_at", "op": "within_days", "value": 30}
]}
```

Fields: `email`, `phone`, `name`, `source`, `locale`, `country`, `timezone`, `lifecycle_stage`, `rc_app_user_id`, `tags`, `created_at`, `updated_at`.
Operators: `eq`, `neq`, `in`, `not_in`, `contains`, `starts_with`, `is_null`, `is_not_null`, `has_tag`, `has_any_tag`, `has_all_tags`, `before`, `after`, `within_days`.

Passing `{"sql": "..."}` is rejected with an explanation, as is any field outside the allow-list. Every value becomes a bound parameter; nothing user-supplied is ever concatenated into a query string.

---

## Claude Desktop configuration

```json
{
  "mcpServers": {
    "bestie-growth-crm": {
      "command": "node",
      "args": ["/abs/path/bestie-growth-crm/dist/index.js"],
      "env": {
        "CRM_DATABASE_URL": "postgres://crm_service:...@....pooler.supabase.com:6543/postgres?sslmode=require",
        "ANTHROPIC_API_KEY": "...",
        "RESEND_API_KEY": "...",
        "SENDER_PHYSICAL_ADDRESS": "Bestie Labs, 123 Example St, San Francisco, CA 94110",
        "UNSUBSCRIBE_BASE_URL": "https://bestie.app/u"
      }
    }
  }
}
```

For a hosted deployment set `CRM_TRANSPORT=http` and `CRM_MCP_BEARER_TOKEN`; the server then serves MCP at `POST /mcp` and the event bridge at `POST /crm/ingest`, both behind the bearer token. `CRM_TRANSPORT=both` runs stdio and HTTP together.

Secrets are server-side only — no tool or resource ever returns them.

---

## Environment variables

See [`.env.example`](.env.example) for the annotated list. The ones that matter most:

| Variable | Default | Notes |
| --- | --- | --- |
| `CRM_DATABASE_URL` | — | Required. `crm_service` via the pooler on 6543 |
| `CRM_DB_POOL_MAX` | `5` | Keep small; you share this instance with the app |
| `SENDER_PHYSICAL_ADDRESS` | — | **Email sends are blocked without it** (CAN-SPAM) |
| `UNSUBSCRIBE_BASE_URL` | — | **Email sends are blocked without it** (CAN-SPAM) |
| `CRM_MCP_BEARER_TOKEN` | — | Required for HTTP. Also the HMAC secret for unsubscribe and approval tokens |
| `BULK_APPROVAL_THRESHOLD` | `200` | Recipients above which a human must approve |
| `FREQUENCY_CAP` | `2` | Messages per contact per rolling window |
| `DAILY_SPEND_CEILING_USD` | `50` | Crossing it pauses the campaign |

A channel with missing credentials refuses to send while dry runs keep working, which makes a planning-only deployment straightforward.

---

## Project layout

```
src/
  index.ts              MCP bootstrap (stdio + Streamable HTTP + /crm/ingest)
  config.ts             the only module that reads process.env
  context.ts            wiring: pool, adapters, rate limiter, copy engine
  db/                   pool.ts, migrate.ts, repo.ts, isolation.ts
  migrations/           0001_crm_schema.sql, 0002_views_grants.sql
  core/                 consentGate, compliance, segmentAst, rateLimiter,
                        sendPipeline, render, copygen, funnel, audit
  channels/             email (Resend), sms (Twilio), push (Expo) behind one adapter interface
  tools/                contacts, consent, segments, templates, campaigns,
                        send, referral, analytics, ingest
  resources/  prompts/
tests/                  153 tests, all pure logic -- no network, no database
scripts/                demo.mjs, verify-send-paths.mjs, copy-migrations.mjs
```

The compliance logic in `core/` is deliberately pure and clock-injected: the gate takes facts and returns a decision, so every rule above is tested exhaustively without a database or a network.

There is exactly one path from a list of contacts to a delivered message (`core/sendPipeline.ts`), used by both the campaign tools and the single-send tools — so a one-off `crm_send_email` cannot become the hole in the gate.

---

## Non-goals

No autonomous unsupervised bulk sending. No cold outreach to non-consented, purchased or scraped contacts. No fake reviews, bot engagement or fabricated social proof. No pulling app users' private data into marketing — only marketing opt-ins enter the CRM, honouring Bestie's zero-collection promise.
