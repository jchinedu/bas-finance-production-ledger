import { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/pool.js';
import { getTrialBalance } from '../domain/ledger.js';

export const ledgerRoutes: FastifyPluginAsync = async (app) => {

  /**
   * GET /ledger/trial-balance
   * Returns full trial balance across all accounts
   */
  app.get('/trial-balance', async () => {
    const client = await pool.connect();
    try {
      const rows = await getTrialBalance(client);
      return rows.map((r) => ({
        code: r.code,
        name: r.name,
        type: r.type,
        totalDebit: r.totalDebit.toString(),
        totalCredit: r.totalCredit.toString(),
        net: r.net.toString(),
      }));
    } finally {
      client.release();
    }
  });

  /**
   * GET /ledger/entries/:loanId
   * Journal entries for a specific loan
   */
  app.get<{
    Params: { loanId: string };
    Querystring: { limit?: string; offset?: string };
  }>('/entries/:loanId', async (req) => {
    const limit = Math.min(Math.max(1, Number(req.query.limit ?? 100)), 500);
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const { rows } = await pool.query(
      `SELECT
         je.id, je.description, je.entry_date, je.reference,
         je.reversal_of, je.reversed_by, je.created_at,
         json_agg(json_build_object(
           'account', a.code,
           'debitKobo', jl.debit_kobo,
           'creditKobo', jl.credit_kobo
         ) ORDER BY jl.id) AS lines
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id = je.id
       JOIN accounts a ON a.id = jl.account_id
       WHERE je.loan_id = $1
       GROUP BY je.id
       ORDER BY je.entry_date, je.id
       LIMIT $2 OFFSET $3`,
      [req.params.loanId, limit, offset]
    );
    return rows;
  });
};
