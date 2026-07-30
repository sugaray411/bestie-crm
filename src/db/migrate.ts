import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';
import { createPool } from './pool.js';
import { loadConfig } from '../config.js';
import { checkIsolation } from './isolation.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Works whether we are running from `dist/db` or from `src/db` via tsx. */
export function migrationsDir(): string {
  for (const candidate of [join(HERE, '..', 'migrations'), join(HERE, '..', '..', 'src', 'migrations')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Could not locate the migrations directory.');
}

export interface MigrationResult {
  id: string;
  status: 'applied' | 'already-applied' | 'skipped';
  reason?: string;
}

/** PostgreSQL's "permission denied" class. */
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Applies every migration in `src/migrations` exactly once, tracking history in
 * `crm.migrations` -- the CRM's own table, never the app's.
 *
 * A migration whose header carries `@optional` may fail with a privilege error
 * without stopping the run: 0002 creates the contract views in `public`, which
 * only the database owner can do. It is recorded as skipped and retried on the
 * next run, so an owner can apply it later without any manual bookkeeping.
 */
export async function runMigrations(db: Db): Promise<MigrationResult[]> {
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const results: MigrationResult[] = [];

  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const optional = /^--.*@optional/m.test(sql);

    // 0001 creates crm.migrations itself, so the bookkeeping table may not exist
    // on the very first run.
    const record = await appliedRecord(db, file);
    if (record?.applied) {
      results.push({
        id: file,
        status: 'already-applied',
        // An applied migration that no longer matches what is on disk means the
        // database and the repository have diverged. Silently skipping it is how
        // that goes unnoticed until something breaks in production.
        ...(record.checksum !== checksum
          ? {
              reason:
                'WARNING: this file has changed since it was applied. Migrations are immutable once applied -- ' +
                'add a new migration instead of editing this one.',
            }
          : {}),
      });
      continue;
    }

    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(
        `insert into crm.migrations (id, checksum, skipped, skip_reason)
         values ($1, $2, false, null)
         on conflict (id) do update set checksum = excluded.checksum,
                                        applied_at = now(),
                                        skipped = false,
                                        skip_reason = null`,
        [file, checksum],
      );
      await client.query('commit');
      results.push({ id: file, status: 'applied' });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (optional && code === INSUFFICIENT_PRIVILEGE) {
        await db
          .query(
            `insert into crm.migrations (id, checksum, skipped, skip_reason)
             values ($1, $2, true, $3)
             on conflict (id) do update set skipped = true, skip_reason = excluded.skip_reason`,
            [file, checksum, message],
          )
          .catch(() => undefined);
        results.push({
          id: file,
          status: 'skipped',
          reason: `${message} -- this migration must be run by the database owner (§4b).`,
        });
        continue;
      }
      throw new Error(`Migration ${file} failed: ${message}`);
    } finally {
      client.release();
    }
  }

  return results;
}

async function appliedRecord(
  db: Db,
  id: string,
): Promise<{ applied: boolean; checksum: string } | null> {
  try {
    const { rows } = await db.query<{ skipped: boolean; checksum: string }>(
      'select skipped, checksum from crm.migrations where id = $1',
      [id],
    );
    const row = rows[0];
    if (row === undefined) return null;
    // A skipped migration is not applied -- retry it, in case we now have rights.
    return { applied: row.skipped === false, checksum: row.checksum };
  } catch {
    return null;
  }
}

// `npm run migrate`
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const results = await runMigrations(pool);
    for (const r of results) {
      const suffix = r.reason ? ` (${r.reason})` : '';
      process.stdout.write(`${r.status.padEnd(16)} ${r.id}${suffix}\n`);
    }
    const isolation = await checkIsolation(pool);
    process.stdout.write(`\nConnected as: ${isolation.role}\n`);
    process.stdout.write(`Isolation ${isolation.isolated ? 'OK' : 'FAILED'}\n`);
    for (const note of isolation.notes) process.stdout.write(`  - ${note}\n`);
  } finally {
    await pool.end();
  }
}
