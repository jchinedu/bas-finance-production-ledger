import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const connectionString = process.env['DATABASE_URL'] ?? 'postgres://ledger:ledger@localhost:5432/production_ledger';

export const pool = new Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export type DbClient = pg.PoolClient;
export type Db = typeof pool;

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function withSerializableTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  maxRetries = 5
): Promise<T> {
  let attempt = 0;
  while (true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      // Postgres serialization failure code: 40001
      const pgErr = err as { code?: string };
      if (pgErr.code === '40001' && attempt < maxRetries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
