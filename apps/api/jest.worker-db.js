// One database per Jest worker (#1510), cloned from the migrated test database.
//
// Several DB E2E suites run DDL in a transaction they roll back: the migration tests' ALTER
// TABLE, CREATE POLICY and CREATE TRIGGER. That takes an exclusive lock on a table, and with
// every worker on one database, a suite in another worker reading the same tables could
// deadlock with it. Postgres then cancels one side after deadlock_timeout (1 s): on 2026-11-27,
// data-export.db.e2e.spec.ts's program-spec preview returned 500 because
// progression.db.e2e.spec.ts was running the backfill rerun's ALTER TABLE "custom_program" at
// the same moment. Suites within one worker run one at a time, so a database per worker leaves
// no two suites sharing one.
//
// jest.global-setup.js creates the databases, and jest.env.setup.js points each worker's
// connection strings at its own.

// Workers are numbered from 1; a --runInBand run is worker 1.
function workerDatabaseName(base, workerId) {
  return `${base}_w${workerId}`;
}

function workerDatabaseUrl(url, workerId) {
  const u = new URL(url);
  u.pathname = `/${workerDatabaseName(decodeURIComponent(u.pathname.slice(1)), workerId)}`;
  return u.toString();
}

// Replaces any database left by an earlier run against the same server, so each starts from
// the template's current schema. The connection goes to the `postgres` database because
// CREATE DATABASE ... TEMPLATE fails while any session, this one included, is connected to the
// template.
async function createWorkerDatabases(ownerUrl, count) {
  const { Client } = require('pg');
  const base = decodeURIComponent(new URL(ownerUrl).pathname.slice(1));
  const maintenance = new URL(ownerUrl);
  maintenance.pathname = '/postgres';
  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    for (let id = 1; id <= count; id++) {
      const name = workerDatabaseName(base, id);
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await client.query(`CREATE DATABASE "${name}" TEMPLATE "${base}"`);
    }
  } finally {
    await client.end();
  }
}

module.exports = { createWorkerDatabases, workerDatabaseUrl };
