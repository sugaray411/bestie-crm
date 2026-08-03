# Setup checklist

Everything that has to be done by a human, in dependency order. The code is
finished; these are the steps only you can do.

**Where does this go?** Into the **existing AI Bestie Supabase project**, not a
new one. The CRM lives in its own `crm` schema and connects as a least-privilege
`crm_service` role, so it cannot read app tables — that is the isolation, and it
does not require separate infrastructure. A separate project would break the
`crm_v_*` contract views (you cannot create a view across two database servers),
the event bridge, and every revenue/referral metric.

---

## 1. Verify the app's real schema — do this first

`migrations/0002_views_grants.sql` assumes column names taken from the build
brief. They have never been checked against the real database. Run this in the
Supabase SQL Editor:

```sql
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name in ('subscriptions','referrals')
order by table_name, ordinal_position;
```

Expected:

| Table | Columns the views need |
| --- | --- |
| `subscriptions` | `rc_app_user_id`, `status`, `started_at`, `current_period_end`, `plan` |
| `referrals` | `referrer_code`, `rewarded_at` |

**If any name differs, edit `0002_views_grants.sql` before running it.**
Otherwise the views fail to create or return wrong data, and `crm_ltv_cac` /
`crm_get_referral_stats` break.

- [ ] Column names verified (or `0002` edited to match)

---

## 2. Create the role and schema

Supabase SQL Editor, as the owner. Generate a strong password first and put it
somewhere safe — you cannot read it back out later.

```sql
create role crm_service login password '<GENERATE_A_STRONG_PASSWORD>';
create schema if not exists crm authorization crm_service;
grant usage on schema crm to crm_service;
grant all privileges on all tables in schema crm to crm_service;
alter default privileges in schema crm grant all on tables to crm_service;

-- crm_service must NOT be able to read app tables:
revoke all on schema public from crm_service;
revoke all on all tables in schema public from crm_service;
```

Then build the connection string from **Project Settings → Database →
Connection string → Transaction pooler** (port **6543**, not 5432). Swap in
`crm_service` and its password. The pooler expects the username in
`<role>.<project-ref>` form, so copy the shape from the dashboard string rather
than writing it by hand.

- [ ] Role created, password stored
- [ ] Pooler connection string built (port 6543)

---

## 3. Deploy the CRM with a public HTTPS URL

The unsubscribe link and both webhooks must be publicly reachable, so this has
to be hosted before any real send. `Dockerfile` and `fly.toml` are committed and
configured — `fly.toml` sets `CRM_TRANSPORT=http` and `CRM_HTTP_PORT=8080` to
match `internal_port`, and health-checks `/health`.

Everything else is a secret and must be set out of band. **The app will not boot
without `CRM_MCP_BEARER_TOKEN`** — that is deliberate, since serving MCP over
HTTP without it would be an open door.

```bash
fly secrets set \
  CRM_DATABASE_URL='postgres://crm_service...@...pooler.supabase.com:6543/postgres?sslmode=require' \
  CRM_MCP_BEARER_TOKEN="$(openssl rand -hex 32)" \
  CRM_PUBLIC_URL='https://bestie-crm.fly.dev' \
  SENDER_PHYSICAL_ADDRESS='Bestie Labs, 123 Example St, San Francisco, CA 94110' \
  UNSUBSCRIBE_BASE_URL='https://bestie-crm.fly.dev/u' \
  ANTHROPIC_API_KEY='sk-ant-...' \
  RESEND_API_KEY='re_...' \
  RESEND_WEBHOOK_SECRET='whsec_...'

fly deploy
curl https://bestie-crm.fly.dev/health   # expect {"status":"ok","server":"bestie-growth-crm"}
```

Save `CRM_MCP_BEARER_TOKEN` somewhere durable: it is also the HMAC key for
unsubscribe links and bulk-approval tokens, so rotating it invalidates every
unsubscribe link already sitting in someone's inbox.

`CRM_PUBLIC_URL` must match the hostname exactly — Twilio signs over the full
request URL, so a mismatch makes every inbound webhook fail with a 401.

- [ ] Secrets set
- [ ] Deployed, `GET /health` returns `{"status":"ok"}`

---

## 4. Run the migrations

```bash
# As crm_service — applies 0001, records 0002 as skipped (by design)
CRM_DATABASE_URL="postgres://crm_service...:6543/postgres?sslmode=require" npm run migrate

# Once as an owner-level connection — applies 0002 (views + grants)
CRM_DATABASE_URL="postgres://postgres...:6543/postgres?sslmode=require" npm run migrate
```

Re-run as `crm_service` and confirm:

```
Connected as: crm_service
Isolation OK
```

**If it lists raw app tables as readable, stop** — the connection string is
using the wrong role. That check exists precisely to catch this.

- [ ] `0001` applied
- [ ] `0002` applied by owner
- [ ] `Isolation OK` as `crm_service`

---

## 5. Resend

1. **Domains → Add Domain**. Add the DNS records it gives you: SPF, DKIM, and a
   DMARC record. Verification takes hours, sometimes a day.
2. **Webhooks → Add Endpoint** → `https://<your-crm-host>/webhooks/resend`
3. Subscribe to: `email.delivered`, `email.opened`, `email.clicked`,
   `email.bounced`, `email.complained`
4. Copy the signing secret (`whsec_…`) into `RESEND_WEBHOOK_SECRET`

Verify by sending yourself a test, then:

```sql
select status from crm.messages order by sent_at desc limit 1;
```

It should reach `delivered` rather than sitting at `sent`.

- [ ] Domain verified (SPF + DKIM + DMARC)
- [ ] Webhook added and secret set
- [ ] Test message reached `delivered`

---

## 6. Twilio — start now if SMS is in scope

**A2P 10DLC registration takes weeks.** Console → Messaging → Regulatory
Compliance → register brand and campaign. Nothing US-bound sends reliably until
it clears. Skip this section entirely if you are email-only for now.

Once you have a number: **Phone Numbers → your number → Messaging → "A message
comes in"** → webhook `https://<your-crm-host>/webhooks/twilio`, method POST.

> `CRM_PUBLIC_URL` must produce *exactly* the URL you typed into Twilio. Twilio
> signs over the full request URL, so a trailing slash or a proxy-rewritten host
> makes every signature fail with a 401.

- [ ] A2P 10DLC submitted
- [ ] Inbound webhook configured

---

## 7. App-side work (two changes)

### a) Marketing opt-in — the real blocker on a first campaign

The CRM has no consented contacts and cannot manufacture any. Product events
from the bridge deliberately grant no consent. Add a toggle in settings or
signup, and on change call `crm_record_consent` (or insert into `crm.consents`)
with a `source` describing the actual UI element that was used.

Nothing can be sent until this exists and real people have used it.

### b) RevenueCat webhook

In the handler, after updating subscription status:

```sql
insert into crm.events_inbox (type, contact_ref, value, source)
values ('subscribe', '{"rc_app_user_id":"..."}'::jsonb, 9.99, 'revenuecat-webhook');
```

**No `RETURNING` clause** — it requires SELECT privilege, which insert-only
deliberately withholds. The `§4c` block in `0002` grants the app's role the
INSERT and the RLS policy it needs.

Optionally also emit `video_call_used` / `chat_used`; those are what let
`crm_feature_engagement` tell you whether the video hook converts better than
free chat.

- [ ] Opt-in UI shipped and writing consent
- [ ] RevenueCat handler inserting into `crm.events_inbox`

---

## 8. Configure and connect

Copy `.env.example` to `.env` and fill it in. Both of these block email sends
entirely if unset, by design:

- `SENDER_PHYSICAL_ADDRESS`
- `UNSUBSCRIBE_BASE_URL` — must point at this server's `/u` route

Then add the config block from the README to `claude_desktop_config.json`.

Run `npm run demo` against a development project first. It dry-runs the whole
flow and sends nothing.

- [ ] `.env` complete
- [ ] Claude Desktop connected, `tools/list` shows 38 tools
- [ ] `npm run demo` passes

---

## 9. First campaign

Only after 1–8. Create a segment, generate copy, create the campaign, and run
`crm_send_campaign` as a **dry run**. Read the per-contact plan and the skip
reasons before setting `dry_run=false` and `confirm=true`.

---

## Order that actually matters

- **1 → 2 → 4** unblocks everything else.
- **6** should start today if SMS matters — the clock is weeks, not days.
- **7a** paces the first real campaign more than anything technical does.
- **Do not do a real send before 3 and 5.** Until the CRM is publicly reachable,
  the unsubscribe link in every email is dead, which is a CAN-SPAM violation.
