import { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/pool.js';
import { closePeriod, reconcile } from '../domain/periodClose.js';

export const periodRoutes: FastifyPluginAsync = async (app) => {

  /**
   * POST /periods/:year/:month/close
   * Close an accounting period (Task 5)
   */
  app.post<{ Params: { year: string; month: string } }>(
    '/:year/:month/close',
    async (req, reply) => {
      const year = Number(req.params.year);
      const month = Number(req.params.month);

      if (!Number.isInteger(year) || !Number.isInteger(month) || year < 1970 || year > 2200 || month < 1 || month > 12) {
        return reply.status(400).send({ error: 'INVALID_PERIOD' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await closePeriod(client, year, month);
        await client.query('COMMIT');
        return reply.status(200).send({
          periodId: result.periodId.toString(),
          year,
          month,
          status: 'closed',
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  );

  /**
   * GET /periods
   * List all periods
   */
  app.get('/', async () => {
    const { rows } = await pool.query(
      `SELECT id, year, month, status, closed_at FROM accounting_periods ORDER BY year, month`
    );
    return rows;
  });

  /**
   * GET /periods/reconcile
   * Run reconciliation (Task 5)
   */
  app.get('/reconcile', async (_req, reply) => {
    const client = await pool.connect();
    try {
      const result = await reconcile(client);
      return reply.status(result.balanced ? 200 : 200).send({
        balanced: result.balanced,
        controlAccounts: {
          loansReceivable: result.loansReceivableControl.toString(),
          interestReceivable: result.interestReceivableControl.toString(),
          unappliedCredit: result.unappliedCreditControl.toString(),
          invoiceReceivable: result.invoiceReceivableControl.toString(),
          clientPayable: result.clientPayableControl.toString(),
          clientReceivable: result.clientReceivableControl.toString(),
        },
        loanBreakdown: result.loanBreakdown.map((lb) => ({
          loanId: lb.loanId.toString(),
          loansReceivable: lb.loansReceivable.toString(),
          interestReceivable: lb.interestReceivable.toString(),
          unappliedCredit: lb.unappliedCredit.toString(),
          difference: lb.difference.toString(),
        })),
        invoiceBreakdown: result.invoiceBreakdown.map((ib) => ({
          loanId: ib.loanId.toString(),
          status: ib.status,
          invoiceReceivable: ib.invoiceReceivable.toString(),
          clientPayable: ib.clientPayable.toString(),
          clientReceivable: ib.clientReceivable.toString(),
          difference: ib.difference.toString(),
        })),
        differences: result.differences.map((d) => ({
          loanId: d.loanId.toString(),
          account: d.account,
          controlAmount: d.controlAmount.toString(),
          loanLevelAmount: d.loanLevelAmount.toString(),
          diff: d.diff.toString(),
        })),
      });
    } finally {
      client.release();
    }
  });
};
