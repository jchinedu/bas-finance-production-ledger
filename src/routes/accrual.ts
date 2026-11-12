import { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/pool.js';
import { runAccrualJob } from '../domain/loanService.js';
import { isValidIsoDate } from '../validation.js';

export const accrualRoutes: FastifyPluginAsync = async (app) => {

  /**
   * POST /accrual/run
   * Run the accrual job: post interest for all due, unaccrued instalments
   * Body: { asOfDate: "YYYY-MM-DD" }
   */
  app.post<{ Body: { asOfDate: string } }>('/run', async (req, reply) => {
    const { asOfDate } = req.body ?? ({} as { asOfDate?: string });
    if (!asOfDate) {
      return reply.status(400).send({ error: 'MISSING_FIELDS', message: 'asOfDate required' });
    }
    if (!isValidIsoDate(asOfDate)) {
      return reply.status(400).send({ error: 'INVALID_DATE', message: 'asOfDate must be a valid ISO calendar date (YYYY-MM-DD)' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await runAccrualJob(client, asOfDate);
      await client.query('COMMIT');

      return {
        accruedCount: result.accruedCount,
        entryIds: result.entryIds.map(String),
        asOfDate,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
};
