import { pool } from './pool.js';

async function reset() {
  const client = await pool.connect();
  try {
    await client.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO PUBLIC;
    `);
    console.log('✅ Database reset complete');
  } finally {
    client.release();
    await pool.end();
  }
}

reset().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
