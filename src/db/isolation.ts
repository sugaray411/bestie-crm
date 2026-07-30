import type { Db } from './pool.js';

/**
 * Proves the isolation contract of §4a/§4b at runtime: the CRM can read and
 * write its own schema, and cannot read raw app tables -- only the crm_v_*
 * views. Kept separate from migrate.ts so importing it never pulls in the CLI.
 */

export interface IsolationReport {
  role: string;
  canWriteCrmSchema: boolean;
  rawAppTablesReadable: string[];
  contractViewsReadable: string[];
  isolated: boolean;
  notes: string[];
}

const RAW_APP_TABLES = [
  'public.users',
  'public.interactions',
  'public.subscriptions',
  'public.referrals',
];
const CONTRACT_VIEWS = ['public.crm_v_subscriptions', 'public.crm_v_referrals'];

export async function checkIsolation(db: Db): Promise<IsolationReport> {
  const notes: string[] = [];
  const { rows } = await db.query<{ role: string }>('select current_user as role');
  const role = rows[0]?.role ?? 'unknown';

  // A rolled-back insert proves write access without leaving a row behind.
  let canWriteCrmSchema = false;
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into crm.audit_log (actor, tool, args_redacted, result_summary)
       values ('isolation-check', 'checkIsolation', '{}'::jsonb, 'write probe')`,
    );
    await client.query('rollback');
    canWriteCrmSchema = true;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    notes.push(`Cannot write to the crm schema: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.release();
  }

  const rawAppTablesReadable: string[] = [];
  for (const table of RAW_APP_TABLES) {
    if (await canSelect(db, table)) rawAppTablesReadable.push(table);
  }

  const contractViewsReadable: string[] = [];
  for (const view of CONTRACT_VIEWS) {
    if (await canSelect(db, view)) contractViewsReadable.push(view);
    else notes.push(`${view} is not readable -- the app team creates it and grants SELECT (§4b).`);
  }

  if (rawAppTablesReadable.length > 0) {
    notes.push(
      `Least-privilege violation: ${role} can select from ${rawAppTablesReadable.join(', ')}. ` +
        'The CRM must reach app data only through the crm_v_* views. Check that CRM_DATABASE_URL uses ' +
        'crm_service and not the app role.',
    );
  }

  return {
    role,
    canWriteCrmSchema,
    rawAppTablesReadable,
    contractViewsReadable,
    isolated: canWriteCrmSchema && rawAppTablesReadable.length === 0,
    notes,
  };
}

async function canSelect(db: Db, relation: string): Promise<boolean> {
  try {
    await db.query(`select 1 from ${relation} limit 1`);
    return true;
  } catch {
    return false;
  }
}
