import { FastifyPluginAsync } from 'fastify';
import { withTransaction } from '../db/pool.js';
import { createTermLoan, createInvoiceFinancing, settleInvoice } from '../domain/loanService.js';
import { pool } from '../db/pool.js';
import { MAX_BIGINT, isValidIsoDate, parseId } from '../validation.js';

export const loanRoutes: FastifyPluginAsync = async (app) => {

  /**
   * POST /loans/term
   * Create a term loan + schedule + disbursement entry
   */
  app.post<{
    Body: {
      principalKobo: string;
      annualRateBps: number;
      termMonths: number;
      disbursementDate: string;
    };
  }>('/term', async (req, reply) => {
    const { principalKobo, annualRateBps, termMonths, disbursementDate } = req.body;

    if (principalKobo == null || annualRateBps == null || termMonths == null || !disbursementDate) {
      return reply.status(400).send({
        error: 'MISSING_FIELDS',
        message: 'principalKobo, annualRateBps, termMonths, disbursementDate required'
      });
    }

    let pKobo: bigint;
    try {
      pKobo = BigInt(principalKobo);
    } catch {
      return reply.status(400).send({ error: 'INVALID_AMOUNT', message: 'principalKobo must be an integer' });
    }

    if (pKobo <= 0n || pKobo > MAX_BIGINT) {
      return reply.status(400).send({ error: 'INVALID_AMOUNT', message: 'principalKobo must be between 1 and PostgreSQL BIGINT maximum' });
    }
    if (typeof annualRateBps !== 'number' || !Number.isInteger(annualRateBps) || annualRateBps < 0 || annualRateBps > 100_000) {
      return reply.status(400).send({ error: 'INVALID_RATE', message: 'annualRateBps must be an integer between 0 and 100000 (0% to 1000%)' });
    }
    if (typeof termMonths !== 'number' || !Number.isInteger(termMonths) || termMonths <= 0 || termMonths > 360) {
      return reply.status(400).send({ error: 'INVALID_TENOR', message: 'termMonths must be an integer between 1 and 360' });
    }
    if (!isValidIsoDate(disbursementDate)) {
      return reply.status(400).send({ error: 'INVALID_DATE', message: 'disbursementDate must be a valid ISO calendar date (YYYY-MM-DD)' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createTermLoan(client, {
        principalKobo: pKobo,
        annualRateBps,
        termMonths,
        disbursementDate,
      });
      await client.query('COMMIT');

      return reply.status(201).send({
        loanId: result.loanId.toString(),
        disbursementEntryId: result.disbursementEntryId.toString(),
        schedule: result.schedule.instalments.map((i) => ({
          periodNumber: i.periodNumber,
          dueDate: i.dueDate,
          instalmentKobo: i.instalmentKobo.toString(),
          interestKobo: i.interestKobo.toString(),
          principalKobo: i.principalKobo.toString(),
          openingBalance: i.openingBalance.toString(),
          closingBalance: i.closingBalance.toString(),
        })),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * GET /loans/:id/schedule
   */
  app.get<{ Params: { id: string } }>('/:id/schedule', async (req, reply) => {
    const { rows } = await pool.query(
      `SELECT i.*, l.principal_kobo, l.annual_rate_bps, l.term_months
       FROM instalments i
       JOIN loans l ON l.id = i.loan_id
       WHERE i.loan_id = $1
       ORDER BY i.period_number`,
      [req.params.id]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'NOT_FOUND' });
    return rows.map((r) => ({
      periodNumber: r.period_number,
      dueDate: r.due_date,
      instalmentKobo: r.instalment_kobo,
      interestKobo: r.interest_kobo,
      principalKobo: r.principal_kobo,
      openingBalance: r.opening_balance,
      closingBalance: r.closing_balance,
      status: r.status,
      accrued: r.accrued,
    }));
  });

  /**
   * POST /loans/invoice
   * Create an invoice financing deal
   */
  app.post<{
    Body: {
      faceValueKobo: string;
      dueDate: string;
      disbursementDate: string;
      annualRateBps?: number;
    };
  }>('/invoice', async (req, reply) => {
    const { faceValueKobo, dueDate, disbursementDate, annualRateBps } = req.body;

    if (!faceValueKobo || !dueDate || !disbursementDate) {
      return reply.status(400).send({
        error: 'MISSING_FIELDS',
        message: 'faceValueKobo, dueDate, disbursementDate required'
      });
    }

    let fvKobo: bigint;
    try {
      fvKobo = BigInt(faceValueKobo);
    } catch {
      return reply.status(400).send({ error: 'INVALID_AMOUNT', message: 'faceValueKobo must be an integer' });
    }

    if (fvKobo <= 0n || fvKobo > MAX_BIGINT) {
      return reply.status(400).send({ error: 'INVALID_AMOUNT', message: 'faceValueKobo must be between 1 and PostgreSQL BIGINT maximum' });
    }

    if (!isValidIsoDate(dueDate) || !isValidIsoDate(disbursementDate)) {
      return reply.status(400).send({ error: 'INVALID_DATE', message: 'dueDate and disbursementDate must be valid ISO calendar dates (YYYY-MM-DD)' });
    }

    if (disbursementDate >= dueDate) {
      return reply.status(400).send({ error: 'INVALID_DATE', message: 'dueDate must be at least one day after disbursementDate' });
    }

    if (annualRateBps != null && (typeof annualRateBps !== 'number' || !Number.isInteger(annualRateBps) || annualRateBps < 0 || annualRateBps > 100_000)) {
      return reply.status(400).send({ error: 'INVALID_RATE', message: 'annualRateBps must be an integer between 0 and 100000' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await createInvoiceFinancing(client, {
        faceValueKobo: fvKobo,
        dueDate,
        disbursementDate,
        annualRateBps,
      });
      await client.query('COMMIT');
      return reply.status(201).send({
        loanId: result.loanId.toString(),
        invoiceId: result.invoiceId.toString(),
        advanceKobo: result.advanceKobo.toString(),
        reserveKobo: result.reserveKobo.toString(),
        discountFeeKobo: result.discountFeeKobo.toString(),
        disbursementEntryId: result.disbursementEntryId.toString(),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * POST /loans/invoice/:id/settle
   * Settle an invoice financing deal supporting partial, full, and excess settlement
   */
  app.post<{
    Params: { id: string };
    Body: { settlementDate: string; settlementAmountKobo?: string };
  }>('/invoice/:id/settle', async (req, reply) => {
    const { settlementDate, settlementAmountKobo } = req.body ?? ({} as { settlementDate?: string; settlementAmountKobo?: string });
    const invoiceId = parseId(req.params.id);
    if (invoiceId === null) {
      return reply.status(400).send({ error: 'INVALID_ID', message: 'invoice id must be a positive integer' });
    }
    if (!settlementDate) {
      return reply.status(400).send({ error: 'MISSING_FIELDS', message: 'settlementDate required' });
    }
    if (!isValidIsoDate(settlementDate)) {
      return reply.status(400).send({ error: 'INVALID_DATE', message: 'settlementDate must be a valid ISO calendar date (YYYY-MM-DD)' });
    }

    let amtKobo: bigint | undefined;
    if (settlementAmountKobo != null) {
      try {
        amtKobo = BigInt(settlementAmountKobo);
        if (amtKobo <= 0n || amtKobo > MAX_BIGINT) {
          return reply.status(400).send({ error: 'INVALID_AMOUNT', message: 'settlementAmountKobo must be positive and within BIGINT range' });
        }
      } catch {
        return reply.status(400).send({ error: 'INVALID_AMOUNT', message: 'settlementAmountKobo must be an integer' });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await settleInvoice(
        client,
        invoiceId,
        settlementDate,
        amtKobo
      );
      await client.query('COMMIT');
      return reply.status(200).send({
        journalEntryId: result.journalEntryId.toString(),
        clientPayableKobo: result.clientPayableKobo.toString(),
        clientReceivableKobo: result.clientReceivableKobo.toString(),
        isShortfall: result.isShortfall,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
};
