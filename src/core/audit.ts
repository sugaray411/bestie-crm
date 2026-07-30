import type { Db } from '../db/pool.js';

/**
 * Every mutation lands in crm.audit_log -- with arguments redacted first (§7.9).
 * The log exists to answer "who sent what to whom, and on what basis", which
 * needs identifiers and decisions, not message bodies or raw addresses.
 */

const SECRET_KEYS = /^(.*_)?(api[_-]?key|token|secret|password|authorization|auth|credential)s?$/i;
const PII_KEYS = /^(email|phone|to|recipient|push_token|pushToken|ip)$/i;
const BODY_KEYS = /^(body|html|text|message|content|copy|subject)$/i;

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEYS.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    if (PII_KEYS.test(key)) {
      if (value.includes('@')) return maskEmail(value);
      if (/\d{4,}/.test(value)) return maskPhone(value);
      return '[redacted]';
    }
    if (BODY_KEYS.test(key)) return `[${value.length} chars omitted]`;
  }
  return redactArgs(value);
}

/** Deep-redacts an arbitrary argument object; safe to call on anything. */
export function redactArgs(input: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (input === null || input === undefined) return input ?? null;
  if (Array.isArray(input)) {
    const head = input.slice(0, 20).map((v) => redactArgs(v, depth + 1));
    return input.length > 20 ? [...head, `[+${input.length - 20} more]`] : head;
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = typeof value === 'object' && value !== null && !SECRET_KEYS.test(key) && !PII_KEYS.test(key)
        ? redactArgs(value, depth + 1)
        : redactValue(key, value);
    }
    return out;
  }
  if (typeof input === 'string' && input.length > 500) {
    return `${input.slice(0, 200)}... [${input.length} chars]`;
  }
  return input;
}

export interface AuditEntry {
  actor: string;
  tool: string;
  args: unknown;
  resultSummary: string;
}

/**
 * Audit writes must never take down the operation they are recording, so a
 * failure here is reported to stderr and swallowed.
 */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.query(
      `insert into crm.audit_log (actor, tool, args_redacted, result_summary)
       values ($1, $2, $3::jsonb, $4)`,
      [entry.actor, entry.tool, JSON.stringify(redactArgs(entry.args) ?? {}), entry.resultSummary.slice(0, 2000)],
    );
  } catch (err) {
    process.stderr.write(
      `[crm] audit write failed for ${entry.tool}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
