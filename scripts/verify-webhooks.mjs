/**
 * Verifies the public HTTP surface end-to-end against a running server:
 * the unsubscribe page and one-click POST, the Resend delivery/bounce/complaint
 * webhook, and the Twilio inbound-STOP webhook — including that each rejects
 * unsigned and tampered requests.
 */
import { createHmac } from 'node:crypto';
import pg from 'pg';

const BASE = process.env.CRM_TEST_BASE_URL ?? 'http://127.0.0.1:8792';
const PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? BASE;
const RESEND_SECRET = process.env.RESEND_WEBHOOK_SECRET;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const BEARER = process.env.CRM_MCP_BEARER_TOKEN;

const db = new pg.Pool({ connectionString: process.env.CRM_DATABASE_URL, max: 2 });
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

const stamp = Date.now();

function unsubToken(contactId) {
  return createHmac('sha256', BEARER).update(contactId).digest('hex').slice(0, 32);
}

function svixHeaders(body) {
  const id = `msg_${stamp}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(RESEND_SECRET.slice(6), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}`, 'content-type': 'application/json' };
}

function twilioSigned(params) {
  const url = `${PUBLIC_URL.replace(/\/+$/, '')}/webhooks/twilio`;
  const payload = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', TWILIO_TOKEN).update(Buffer.from(payload, 'utf8')).digest('base64');
}

// --- Seed a contact + a sent message with a known provider id ---------------
const { rows: contactRows } = await db.query(
  `insert into crm.contacts (email, name, country, source) values ($1,'Webhook Test','US','test') returning id`,
  [`hook-${stamp}@example.com`],
);
const contactId = contactRows[0].id;
await db.query(
  `insert into crm.consents (contact_id, channel, status, basis, source) values ($1,'email','granted','opt_in','test')`,
  [contactId],
);
const providerId = `resend-${stamp}`;
await db.query(
  `insert into crm.messages (contact_id, channel, status, provider_id) values ($1,'email','sent',$2)`,
  [contactId, providerId],
);

const statusOf = async () => {
  const { rows } = await db.query('select status from crm.messages where provider_id = $1', [providerId]);
  return rows[0]?.status;
};

// --- 1. Unsubscribe: GET must not mutate (mail clients prefetch links) ------
const goodToken = unsubToken(contactId);
const getRes = await fetch(`${BASE}/u/${contactId}?t=${goodToken}`);
const getBody = await getRes.text();
check('unsubscribe GET renders a confirmation page', getRes.status === 200 && getBody.includes('<form'));

const { rows: afterGet } = await db.query(
  `select count(*)::int as n from crm.suppression where lower(value) = lower($1)`,
  [`hook-${stamp}@example.com`],
);
check('unsubscribe GET does NOT suppress (prefetch safety)', afterGet[0].n === 0);

// --- 2. Unsubscribe: bad token rejected ------------------------------------
const badRes = await fetch(`${BASE}/u/${contactId}?t=deadbeef`, { method: 'POST' });
check('unsubscribe POST rejects a forged token', badRes.status === 400);

// --- 3. Unsubscribe: RFC 8058 one-click ------------------------------------
const oneClick = await fetch(`${BASE}/u/${contactId}?t=${goodToken}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'List-Unsubscribe=One-Click',
});
check('one-click unsubscribe returns a bare 200', oneClick.status === 200);

const { rows: suppressed } = await db.query(
  `select reason from crm.suppression where lower(value) = lower($1)`,
  [`hook-${stamp}@example.com`],
);
check('one-click unsubscribe suppressed the address', suppressed[0]?.reason === 'unsubscribe');

const { rows: consentRows } = await db.query(
  `select status from crm.consents where contact_id = $1 order by ts desc limit 1`,
  [contactId],
);
check('one-click unsubscribe revoked consent', consentRows[0]?.status === 'revoked');

// --- 4. Resend webhook: unsigned rejected ----------------------------------
const unsigned = await fetch(`${BASE}/webhooks/resend`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'email.delivered', data: { email_id: providerId } }),
});
check('Resend webhook rejects an unsigned request', unsigned.status === 401);

// --- 5. Resend webhook: delivery lifecycle advances the message ------------
for (const [type, expected] of [
  ['email.delivered', 'delivered'],
  ['email.opened', 'opened'],
  ['email.clicked', 'clicked'],
]) {
  const body = JSON.stringify({ type, data: { email_id: providerId } });
  const res = await fetch(`${BASE}/webhooks/resend`, { method: 'POST', headers: svixHeaders(body), body });
  const status = await statusOf();
  check(`Resend ${type} advances message to ${expected}`, res.status === 200 && status === expected, status);
}

// --- 6. Out-of-order events must not rewind --------------------------------
const lateBody = JSON.stringify({ type: 'email.delivered', data: { email_id: providerId } });
await fetch(`${BASE}/webhooks/resend`, { method: 'POST', headers: svixHeaders(lateBody), body: lateBody });
check('a late "delivered" does not rewind a clicked message', (await statusOf()) === 'clicked');

// --- 7. Bounce suppresses the address --------------------------------------
const bounceAddr = `bounce-${stamp}@example.com`;
const bounceBody = JSON.stringify({
  type: 'email.bounced',
  data: { email_id: `bounced-${stamp}`, to: [bounceAddr], bounce: { message: 'mailbox does not exist' } },
});
const bounceRes = await fetch(`${BASE}/webhooks/resend`, {
  method: 'POST',
  headers: svixHeaders(bounceBody),
  body: bounceBody,
});
const { rows: bounceSup } = await db.query(
  `select reason from crm.suppression where lower(value) = lower($1)`,
  [bounceAddr],
);
check('a bounce suppresses the address', bounceRes.status === 200 && bounceSup[0]?.reason === 'bounce');

// --- 8. Spam complaint suppresses and revokes ------------------------------
const complainAddr = `complain-${stamp}@example.com`;
const { rows: cRows } = await db.query(
  `insert into crm.contacts (email, source) values ($1,'test') returning id`,
  [complainAddr],
);
const complainBody = JSON.stringify({ type: 'email.complained', data: { to: [complainAddr] } });
await fetch(`${BASE}/webhooks/resend`, { method: 'POST', headers: svixHeaders(complainBody), body: complainBody });
const { rows: complainSup } = await db.query(
  `select reason from crm.suppression where lower(value) = lower($1)`,
  [complainAddr],
);
const { rows: complainConsent } = await db.query(
  `select status from crm.consents where contact_id = $1 order by ts desc limit 1`,
  [cRows[0].id],
);
check(
  'a spam complaint suppresses and revokes consent',
  complainSup[0]?.reason === 'complaint' && complainConsent[0]?.status === 'revoked',
);

// --- 9. Twilio: unsigned rejected ------------------------------------------
const twUnsigned = await fetch(`${BASE}/webhooks/twilio`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ From: '+15550001111', Body: 'STOP' }),
});
check('Twilio webhook rejects an unsigned request', twUnsigned.status === 401);

// --- 10. Twilio: signed STOP suppresses ------------------------------------
const smsPhone = `+1555${String(stamp).slice(-7)}`;
await db.query(`insert into crm.contacts (phone, source) values ($1,'test')`, [smsPhone]);
const stopParams = { From: smsPhone, Body: 'STOP', MessageSid: `SM${stamp}` };
const stopRes = await fetch(`${BASE}/webhooks/twilio`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': twilioSigned(stopParams),
  },
  body: new URLSearchParams(stopParams),
});
const { rows: smsSup } = await db.query(`select reason from crm.suppression where channel='sms' and value = $1`, [smsPhone]);
check('a signed STOP suppresses the number', stopRes.status === 200 && smsSup[0]?.reason === 'unsubscribe');

// --- 11. Twilio: a normal reply is not an opt-out --------------------------
const chatPhone = `+1556${String(stamp).slice(-7)}`;
const chatParams = { From: chatPhone, Body: 'thanks, this is great!', MessageSid: `SM${stamp}b` };
await fetch(`${BASE}/webhooks/twilio`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': twilioSigned(chatParams),
  },
  body: new URLSearchParams(chatParams),
});
const { rows: chatSup } = await db.query(`select count(*)::int as n from crm.suppression where value = $1`, [chatPhone]);
check('an ordinary inbound reply does not suppress', chatSup[0].n === 0);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await db.end();
process.exit(failed.length === 0 ? 0 : 1);
