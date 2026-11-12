/**
 * Idempotency Service (Task 2)
 *
 * Guarantees:
 *  - Same key + same body → original response (no double-post)
 *  - Same key + different body → 409
 *  - 50 simultaneous requests with same key → exactly one journal entry
 *
 * Uses advisory lock to serialize concurrent requests with same key.
 */

import pg from 'pg';
import crypto from 'crypto';

function hashBody(body: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body))
    .digest('hex');
}

/** fnv1a hash to convert key string to a signed 32-bit integer for advisory lock */
function keyToAdvisoryLockId(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

export interface IdempotencyResult<T> {
  data: T;
  statusCode: number;
  fromCache: boolean;
}

/**
 * Run an operation with idempotency protection.
 * Uses pg_advisory_xact_lock to serialize concurrent requests with the same key
 * within the active transaction block. The lock is held until COMMIT/ROLLBACK,
 * ensuring concurrent requests see committed idempotency records.
 */
export async function withIdempotency<T>(
  client: pg.PoolClient,
  idempotencyKey: string,
  requestBody: unknown,
  operation: () => Promise<{ data: T; statusCode: number }>
): Promise<IdempotencyResult<T>> {
  const requestHash = hashBody(requestBody);
  const lockId = keyToAdvisoryLockId(idempotencyKey);

  // Acquire transaction-level advisory lock (automatically released at COMMIT or ROLLBACK)
  await client.query(`SELECT pg_advisory_xact_lock($1)`, [lockId]);

  // Check if already processed
  const { rows } = await client.query<{
    request_hash: string;
    response_body: unknown;
    status_code: number;
  }>(
    `SELECT request_hash, response_body, status_code
     FROM idempotency_keys WHERE key = $1`,
    [idempotencyKey]
  );

  if (rows.length > 0) {
    const existing = rows[0]!;
    if (existing.request_hash !== requestHash) {
      throw Object.assign(
        new Error(`IDEMPOTENCY_CONFLICT: Idempotency key "${idempotencyKey}" was used with a different request body`),
        { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' }
      );
    }
    // Same key, same body → return cached response
    let data = existing.response_body;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { /* ignore */ }
    }
    return {
      data: data as T,
      statusCode: existing.status_code,
      fromCache: true,
    };
  }

  // Not seen before – run the operation
  const result = await operation();

  // Store the result
  await client.query(
    `INSERT INTO idempotency_keys (key, request_hash, response_body, status_code)
     VALUES ($1, $2, $3, $4)`,
    [idempotencyKey, requestHash, JSON.stringify(result.data), result.statusCode]
  );

  return { ...result, fromCache: false };
}
