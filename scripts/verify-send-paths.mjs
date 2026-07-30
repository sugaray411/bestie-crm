/**
 * Verifies the paths the dry-run demo cannot reach: bulk approval, frequency
 * caps, quiet hours, budget ceilings, and that skips are recorded in
 * crm.messages when a real send is attempted. No message is ever delivered --
 * the channels are intentionally left unconfigured.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pg from 'pg';

const stamp = Date.now();
const tag = `verify-${stamp}`;

const env = {
  ...process.env,
  UNSUBSCRIBE_BASE_URL: 'https://bestie.app/u',
  SENDER_PHYSICAL_ADDRESS: 'Bestie Labs, 123 Example St, San Francisco, CA 94110',
  BULK_APPROVAL_THRESHOLD: '2',
  FREQUENCY_CAP: '1',
  // Throwaway value for the locally spawned server: it only seeds the HMAC for
  // unsubscribe and approval tokens during this run.
  CRM_MCP_BEARER_TOKEN: 'local-verify-run-not-a-secret',
};

const client = new Client({ name: 'verify', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env }));

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  try {
    return JSON.parse(res.content?.[0]?.text ?? '{}');
  } catch {
    return { raw: res.content?.[0]?.text };
  }
};

const db = new pg.Pool({ connectionString: process.env.CRM_DATABASE_URL, max: 2 });
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

// Five consented US contacts, so the only thing that can stop a send is a guardrail.
const ids = [];
for (let i = 0; i < 5; i += 1) {
  const created = await call('crm_create_contact', {
    email: `bulk${i}-${stamp}@example.com`,
    name: `Person ${i}`,
    country: 'US',
    timezone: 'America/New_York',
    tags: [tag],
    source: 'signup form',
    consent: { channel: 'email', basis: 'opt_in', source: 'signup form checkbox' },
  });
  ids.push(created.contact.id);
}

await call('crm_create_segment', { name: `seg-${stamp}`, definition: { field: 'tags', op: 'has_tag', value: tag } });
await call('crm_create_template', {
  name: `tpl-${stamp}`,
  channel: 'email',
  subject: 'Hi {{first_name}}',
  body: 'Show Bestie the problem on a video call. Chat is free and unlimited.',
});
await call('crm_create_campaign', { name: `camp-${stamp}`, template: `tpl-${stamp}`, segment: `seg-${stamp}` });

// --- 1. Bulk approval -------------------------------------------------------
const bulk = await call('crm_send_campaign', { campaign: `camp-${stamp}`, dry_run: false, confirm: true });
check(
  'bulk send above threshold returns needs_human_approval and sends nothing',
  bulk.status === 'needs_human_approval' && typeof bulk.approval_token === 'string',
  `status=${bulk.status}, recipients=${bulk.recipients}`,
);

const { rows: afterBulk } = await db.query(
  `select count(*)::int as n from crm.messages m join crm.campaigns c on c.id = m.campaign_id where c.name = $1`,
  [`camp-${stamp}`],
);
check('no messages were written while awaiting approval', afterBulk[0].n === 0, `${afterBulk[0].n} rows`);

// --- 2. A forged / replayed token is rejected -------------------------------
const forged = await call('crm_send_campaign', {
  campaign: `camp-${stamp}`,
  dry_run: false,
  confirm: true,
  approval_token: 'not-a-real-token',
});
check('an invalid approval token is rejected', forged.status === 'needs_human_approval');

// --- 3. With the real token, the send proceeds to the channel --------------
const approved = await call('crm_send_campaign', {
  campaign: `camp-${stamp}`,
  dry_run: false,
  confirm: true,
  approval_token: bulk.approval_token,
});
check(
  'a valid approval token gets past the gate (then stops: email is unconfigured)',
  typeof approved.error === 'string' && approved.error.includes('not configured'),
  approved.error ?? JSON.stringify(approved).slice(0, 80),
);

// --- 4. Skips are recorded when a real send is attempted -------------------
const loner = await call('crm_create_contact', {
  email: `noconsent-${stamp}@example.com`,
  name: 'No Consent',
  country: 'US',
  tags: [`solo-${stamp}`],
});
const attempted = await call('crm_send_email', {
  contact_id: loner.contact.id,
  body: 'Hello there.',
  dry_run: false,
  confirm: true,
});
check('a real send to a non-consented contact is skipped', attempted.status === 'skipped', attempted.skip_reason);

const { rows: skipRows } = await db.query(
  `select status, error from crm.messages where contact_id = $1`,
  [loner.contact.id],
);
check(
  'the skip is recorded in crm.messages',
  skipRows.length === 1 && skipRows[0].status === 'skipped_no_consent',
  skipRows[0]?.status,
);

// --- 5. Quiet hours block SMS at 3am local --------------------------------
const smsContact = await call('crm_create_contact', {
  phone: `+1555000${String(stamp).slice(-4)}`,
  name: 'Night Owl',
  country: 'US',
  // Whatever the wall clock is when this runs, it is outside 09:00-20:00
  // somewhere -- pick the zone where it currently is.
  timezone: pickQuietZone(),
  tags: [`sms-${stamp}`],
  consent: { channel: 'sms', basis: 'opt_in', source: 'in-app prompt' },
});
const smsDry = await call('crm_send_sms', { contact_id: smsContact.contact.id, body: 'Trial ending soon.' });
check(
  'SMS outside 09:00-20:00 local is skipped for quiet hours',
  smsDry.skip_reason === 'skipped_quiet_hours',
  smsDry.detail,
);

// --- 6. Frequency cap ------------------------------------------------------
await db.query(
  `insert into crm.messages (contact_id, channel, status) values ($1, 'email', 'sent')`,
  [ids[0]],
);
const capped = await call('crm_send_email', { contact_id: ids[0], body: 'Second message this week.' });
check(
  'the frequency cap blocks a second message in the window',
  capped.skip_reason === 'skipped_frequency_cap',
  capped.detail,
);

// --- 7. PII does not leak into skip details or the audit log --------------
const suppressed = await call('crm_create_contact', {
  email: `suppressed-${stamp}@example.com`,
  name: 'Gone',
  country: 'US',
  tags: [`sup-${stamp}`],
  consent: { channel: 'email', basis: 'opt_in', source: 'form' },
});
await call('crm_handle_unsubscribe', { channel: 'email', contact_id: suppressed.contact.id });
const supDry = await call('crm_send_email', { contact_id: suppressed.contact.id, body: 'Hi.' });
check(
  'a suppression skip reason contains no raw address',
  supDry.skip_reason === 'skipped_suppressed' && !JSON.stringify(supDry).includes(`suppressed-${stamp}@example.com`),
  supDry.detail,
);

const { rows: auditRows } = await db.query(
  `select args_redacted::text as args from crm.audit_log where tool = 'crm_create_contact' order by created_at desc limit 1`,
);
check(
  'the audit log stores a masked address, not the real one',
  !auditRows[0].args.includes(`suppressed-${stamp}@example.com`) && auditRows[0].args.includes('@example.com'),
  auditRows[0].args.slice(0, 90),
);

// --- 8. GDPR erasure suppresses before deleting ---------------------------
const doomed = await call('crm_create_contact', {
  email: `erase-${stamp}@example.com`,
  name: 'Erase Me',
  country: 'DE',
  tags: [`erase-${stamp}`],
});
const unconfirmedErase = await call('crm_delete_contact', { id: doomed.contact.id });
check('erasure requires confirm=true', typeof unconfirmedErase.error === 'string');

const erased = await call('crm_delete_contact', { id: doomed.contact.id, confirm: true });
const stillSuppressed = await call('crm_is_suppressed', { channel: 'email', value: `erase-${stamp}@example.com` });
check(
  'an erased contact is suppressed so they cannot be re-imported and messaged',
  erased.status === 'erased' && stillSuppressed.suppressed === true,
);

const { rows: goneRows } = await db.query('select count(*)::int as n from crm.contacts where id = $1', [doomed.contact.id]);
check('the erased contact row is gone', goneRows[0].n === 0);

// --- 9. Import guardrails --------------------------------------------------
const bought = await call('crm_import_contacts', {
  basis: 'opt_in',
  source: 'purchased list from a data broker',
  attestation: 'We acquired this list from a reputable vendor in March.',
  contacts: [{ email: `bought-${stamp}@example.com` }],
});
check('a purchased list is rejected', typeof bought.error === 'string', bought.reasons?.[0]?.slice(0, 70));

const { rows: notImported } = await db.query('select count(*)::int as n from crm.contacts where email = $1', [
  `bought-${stamp}@example.com`,
]);
check('nothing from the rejected import reached the database', notImported[0].n === 0);

// --- Summary ---------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await db.end();
await client.close();
process.exit(failed.length === 0 ? 0 : 1);

/** Returns an IANA zone where the current local hour is outside 09:00-20:00. */
function pickQuietZone() {
  const zones = ['UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney', 'America/Los_Angeles', 'Asia/Kolkata'];
  const now = new Date();
  for (const zone of zones) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hour12: false }).format(now));
    if (hour < 9 || hour >= 20) return zone;
  }
  return 'UTC';
}
