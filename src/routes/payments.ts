import { FastifyPluginAsync } from 'fastify';
import { pool, withTransaction } from '../db/pool.js';
import { allocatePayment, recomputeAllocations } from '../domain/payment.js';
import { withIdempotency } from '../domain/idempotency.js';
import { reversePayment } from '../domain/reversal.js';
import { isValidIsoDate, parseId, parsePositiveKobo } from '../validation.js';

export const paymentRoutes: FastifyPluginAsync = async (app) => {

  /**
   * POST /payments
   * Apply a payment to a loan with idempotency + row-level concurrency lock.
   *
   * Headers:
   *   Idempotency-Key: <string>  (required)
   *
   * Body:
   *   { loanId, amountKobo, paymentDate }
   */
  app.post<{
    Body: { loanId: string; amountKobo: string; paymentDate: string };
  }>('/', async (req, reply) => {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      return reply.status(400).send({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required',
      });
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 255) {
      return reply.status(400).send({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must be a string of at most 255 characters',
      });
    }

    const { loanId, amountKobo, paymentDate } = req.body ?? ({} as Partial<{ loanId: string; amountKobo: string; paymentDate: string }>);
    if (loanId == null || amountKobo == null || !paymentDate) {
      return reply.status(400).send({
        error: 'MISSING_FIELDS',
        message: 'loanId, amountKobo, paymentDate required'
      });
    }

    if (parseId(loanId) === null) {
      return reply.status(400).send({ error: 'INVALID_ID', message: 'loanId must be a positive integer' });
    }
    if (parsePositiveKobo(amountKobo) === null) {
      return reply.status(400).send({
        error: 'INVALID_AMOUNT',
        message: 'amountKobo must be an integer between 1 and 9223372036854775807',
      });
    }
    if (!isValidIsoDate(paymentDate)) {
      return reply.status(400).send({ error: 'INVALID_DATE', message: 'paymentDate must be a valid ISO calendar date (YYYY-MM-DD)' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let responseStatusCode = 201;
      const idempResult = await withIdempotency(
        client,
        idempotencyKey,
        req.body,
        async () => {
          // Lock the loan row to serialize concurrent payment allocation
          const { rows } = await client.query<{ id: string; status: string }>(
            `SELECT id, status FROM loans WHERE id = $1 FOR UPDATE`,
            [loanId]
          );
          if (rows.length === 0) {
            throw Object.assign(new Error(`Loan ${loanId} not found`), { statusCode: 404 });
          }
          if (rows[0]!.status !== 'active') {
            throw Object.assign(
              new Error(`Loan ${loanId} is ${rows[0]!.status}`),
              { statusCode: 422 }
            );
          }

          // Insert payment record
          const { rows: [payRow] } = await client.query<{ id: string }>(
            `INSERT INTO payments (loan_id, idempotency_key, amount_kobo, payment_date)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [loanId, idempotencyKey, amountKobo, paymentDate]
          );
          const paymentId = BigInt(payRow!.id);

          // Allocate
          const allocation = await allocatePayment(client, {
            paymentId,
            loanId: BigInt(loanId),
            amountKobo: BigInt(amountKobo),
            paymentDate,
          });

          // Check if this payment was received out-of-order (payments already exist with payment_date > paymentDate)
          const { rows: laterPayments } = await client.query<{ id: string }>(
            `SELECT id FROM payments
             WHERE loan_id = $1 AND status = 'applied' AND payment_date > $2 AND id <> $3`,
            [loanId, paymentDate, paymentId]
          );

          if (laterPayments.length > 0) {
            // Out-of-order delivery: re-allocate remaining payments in chronological value-date order
            await recomputeAllocations(client, BigInt(loanId), paymentDate, {
              type: 'out_of_order_payment',
              paymentId,
              reason: 'Payment received with a value date earlier than already-applied payments',
            });
          }

          responseStatusCode = 201;
          return {
            data: {
              paymentId: paymentId.toString(),
              journalEntryId: allocation.journalEntryId ? allocation.journalEntryId.toString() : null,
              allocations: allocation.allocations.map((a) => ({
                instalmentId: a.instalmentId?.toString() ?? null,
                type: a.type,
                amountKobo: a.amountKobo.toString(),
              })),
              unappliedKobo: allocation.unappliedKobo.toString(),
            },
            statusCode: 201,
          };
        }
      );

      await client.query('COMMIT');

      const status = idempResult.fromCache ? 200 : 201;
      return reply.status(status).send(idempResult.data);
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const e = err as { statusCode?: number; code?: string; message?: string };
      if (e.code === 'IDEMPOTENCY_CONFLICT') {
        return reply.status(409).send({ error: 'IDEMPOTENCY_CONFLICT', message: e.message });
      }
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * POST /payments/:id/reverse
   * Reverse a payment (Task 4)
   */
  app.post<{
    Params: { id: string };
    Body: { reversalDate: string; reason?: string };
  }>('/:id/reverse', async (req, reply) => {
    const paymentId = parseId(req.params.id);
    if (paymentId === null) {
      return reply.status(400).send({ error: 'INVALID_ID', message: 'payment id must be a positive integer' });
    }
    const { reversalDate, reason } = req.body ?? ({} as Partial<{ reversalDate: string; reason: string }>);

    if (!reversalDate) {
      return reply.status(400).send({ error: 'MISSING_FIELDS', message: 'reversalDate required' });
    }
    if (!isValidIsoDate(reversalDate)) {
      return reply.status(400).send({ error: 'INVALID_DATE', message: 'reversalDate must be a valid ISO calendar date (YYYY-MM-DD)' });
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
      return reply.status(400).send({ error: 'INVALID_REASON', message: 'reason must be a string of at most 500 characters' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the loan row for this payment to serialize
      const { rows: [pmtRow] } = await client.query<{ loan_id: string }>(
        `SELECT loan_id FROM payments WHERE id = $1`,
        [paymentId]
      );
      if (!pmtRow) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: 'NOT_FOUND' });
      }

      await client.query(`SELECT id FROM loans WHERE id = $1 FOR UPDATE`, [pmtRow.loan_id]);

      const result = await reversePayment(client, paymentId, reversalDate, reason);
      await client.query('COMMIT');

      return reply.status(200).send({
        reversedPaymentId: result.reversedPaymentId.toString(),
        reversalEntryId: result.reversalEntryId.toString(),
        correctedPayments: result.correctedPayments.map(String),
        correctingEntries: result.correctingEntries.map(String),
        auditTrail: result.auditTrail.map((entry) => ({
          ...entry,
          paymentId: entry.paymentId != null ? entry.paymentId.toString() : undefined,
          entryId: entry.entryId != null ? entry.entryId.toString() : undefined,
        })),
      });
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const e = err as { code?: string; message?: string };
      if (e.code === 'ALREADY_REVERSED' || e.code === 'CANNOT_REVERSE_REVERSAL') {
        return reply.status(422).send({ error: e.code, message: e.message });
      }
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * GET /payments/:id
   */
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const paymentId = parseId(req.params.id);
    if (!paymentId) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Invalid payment ID' });
    }
    const { rows } = await pool.query(
      `SELECT p.*, 
              json_agg(json_build_object(
                'instalmentId', pa.instalment_id,
                'type', pa.allocation_type,
                'amountKobo', pa.amount_kobo,
                'active', (pa.superseded_by_event_id IS NULL),
                'createdByEventId', pa.created_by_event_id,
                'supersededByEventId', pa.superseded_by_event_id,
                'correctingEntryId', pa.correcting_entry_id
              ) ORDER BY pa.id) FILTER (WHERE pa.id IS NOT NULL) as allocations
       FROM payments p
       LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
       WHERE p.id = $1
       GROUP BY p.id`,
      [paymentId]
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'NOT_FOUND' });
    return rows[0];
  });
};
