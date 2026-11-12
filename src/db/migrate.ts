import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  let schemaPath = join(__dirname, 'schema.sql');
  if (!existsSync(schemaPath)) {
    schemaPath = join(__dirname, '../../src/db/schema.sql');
  }
  const sql = readFileSync(schemaPath, 'utf-8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create schema_migrations table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Execute schema inside transaction
    await client.query(sql);
    await client.query('ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_idempotency_key_fkey;');

    await client.query(`
      INSERT INTO schema_migrations (version, description)
      VALUES ('001_initial_schema', 'Initial double-entry ledger schema, triggers, and accounts')
      ON CONFLICT (version) DO NOTHING;
    `);

    await client.query('COMMIT');
    console.log('✅ Migration complete (idempotent versioned run)');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
