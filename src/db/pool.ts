import pg from 'pg';
import type { Config } from '../config.js';

const { Pool } = pg;

export type Db = pg.Pool;

/**
 * A deliberately small pool (§4e). The MCP server is bursty and short-lived, and
 * it shares a Postgres instance with the app's backend -- a big pool here would
 * starve the thing that actually serves users. Connect through the Supabase
 * transaction pooler (port 6543), not a direct session connection.
 */
export function createPool(config: Config): Db {
  if (!config.databaseUrl) {
    throw new Error(
      'CRM_DATABASE_URL is not set. Point it at the crm_service role via the Supabase transaction pooler (port 6543).',
    );
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // The pooler terminates SSL with a certificate the client cannot chain to a
    // public root, which is normal for Supabase's pooler endpoint.
    ssl: config.databaseUrl.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
    // `crm` first so unqualified writes land in our schema; `public` is present
    // only for the read-only crm_v_* contract views. Set as a startup parameter
    // rather than by issuing `set search_path` on connect, which races with any
    // query the pool hands the client immediately afterwards.
    options: '-c search_path=crm,public',
  });

  pool.on('error', (err) => {
    process.stderr.write(`[crm] idle client error: ${err.message}\n`);
  });

  return pool;
}

/** numeric/bigint come back as strings from pg; parse where we mean a number. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}
