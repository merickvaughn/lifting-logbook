import { Client } from 'pg';

/**
 * The daily snapshot expiry job (#1309, proposal decision 21, ADR-044). A scheduled workflow
 * executes it as a Cloud Run job under the migration role, which owns `data_snapshot`:
 *
 *     node dist/snapshots/expire-snapshots.job.js
 *
 * Row-level security is forced on the table and binds its owner too, so with no user set the
 * isolation policy hides every row. The table's expiry policies let its owner, and no other
 * role, see and delete the rows past `expiresAt`. Run as anyone else, the job would see nothing
 * and report success, so it checks the role first and fails instead.
 *
 * It deletes every expired row, logs how many, and fails if any expired row is left. Reads
 * already treat an expired snapshot as gone, so a late or failed run never extends retention.
 */

export interface Queryable {
  query<R extends object>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface ExpiryLogEntry {
  severity: 'INFO' | 'ERROR';
  message: string;
  deleted?: number;
  remaining?: number;
  role?: string;
  owner?: string;
  error?: string;
}

/** Runs the job on `db` and returns the process exit code. Every outcome is logged once. */
export async function runExpiryJob(db: Queryable, log: (entry: ExpiryLogEntry) => void): Promise<number> {
  try {
    const [who] = (
      await db.query<{ role: string; owner: string; cutoff: Date }>(
        `SELECT current_user AS role, pg_get_userbyid(relowner) AS owner, now() AS cutoff
           FROM pg_class WHERE oid = '"data_snapshot"'::regclass`,
      )
    ).rows;
    if (!who) throw new Error('the data_snapshot table was not found');
    if (who.role !== who.owner) {
      log({
        severity: 'ERROR',
        message: 'Snapshot expiry refused: it must run as the owner of data_snapshot, which alone can see expired rows (#1309)',
        role: who.role,
        owner: who.owner,
      });
      return 1;
    }
    // One cutoff for both statements, so a row expiring between them isn't counted as left.
    const deleted = (await db.query(`DELETE FROM "data_snapshot" WHERE "expiresAt" <= $1`, [who.cutoff])).rowCount ?? 0;
    const [left] = (
      await db.query<{ remaining: string }>(`SELECT count(*) AS remaining FROM "data_snapshot" WHERE "expiresAt" <= $1`, [
        who.cutoff,
      ])
    ).rows;
    const remaining = Number(left?.remaining ?? 0);
    if (remaining > 0) {
      log({ severity: 'ERROR', message: 'Snapshot expiry left expired snapshots behind (#1309)', deleted, remaining });
      return 1;
    }
    log({ severity: 'INFO', message: 'Expired snapshots deleted (#1309)', deleted, remaining });
    return 0;
  } catch (err) {
    log({ severity: 'ERROR', message: 'Snapshot expiry failed (#1309)', error: err instanceof Error ? err.message : String(err) });
    return 1;
  }
}

/** One JSON line on stdout, which Cloud Logging reads as a structured entry with its severity. */
function logJson(entry: ExpiryLogEntry): void {
  console.log(JSON.stringify(entry));
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    process.exitCode = await runExpiryJob(client, logJson);
  } catch (err) {
    logJson({ severity: 'ERROR', message: 'Snapshot expiry could not connect (#1309)', error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) void main();
