/**
 * Shared test helper: spins up a real Postgres container via Testcontainers,
 * runs migrations, and returns a connected pool.
 * Re-used by all test files.
 */

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

let container: StartedPostgreSqlContainer | null = null;
let testPool: pg.Pool | null = null;

export async function setupTestDb(): Promise<pg.Pool> {
  const schemaPath = join(__dirname, '../../db/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');

  try {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('ledger_test')
      .withUsername('ledger')
      .withPassword('ledger')
      .start();

    testPool = new Pool({
      connectionString: container.getConnectionUri(),
      max: 55,
    });
  } catch {
    // Fallback if Testcontainers cannot connect to Docker daemon
    const dbUrl =
      process.env.TEST_DATABASE_URL ||
      process.env.DATABASE_URL ||
      'postgres://ledger:ledger@localhost:5433/production_ledger';
    testPool = new Pool({
      connectionString: dbUrl,
      max: 55,
    });
  }

  // Run schema
  await testPool.query(schema);

  return testPool;
}

export async function teardownTestDb(): Promise<void> {
  await testPool?.end();
  if (container) {
    try {
      await container.stop();
    } catch {
      // ignore
    }
  }
  testPool = null;
  container = null;
}

export async function resetTestDb(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('accounts')) LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}

/** Create a pool client and run fn inside a transaction, rolling back after */
export async function withTestTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
