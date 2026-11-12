import Fastify from 'fastify';
import { createHash, timingSafeEqual } from 'crypto';
import { pool } from './db/pool.js';
import { loanRoutes } from './routes/loans.js';
import { paymentRoutes } from './routes/payments.js';
import { accrualRoutes } from './routes/accrual.js';
import { periodRoutes } from './routes/periods.js';
import { ledgerRoutes } from './routes/ledger.js';

// Enable BigInt JSON serialization globally across all API responses
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

export async function buildApp() {
  const app = Fastify({
    logger: process.env['NODE_ENV'] !== 'test',
    bodyLimit: 1_048_576, // 1MB payload limit
  });

  // Health check (unauthenticated)
  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  // Security: Authentication & Authorization Hook
  const isProd = process.env['NODE_ENV'] === 'production';
  if (isProd) {
    const k = process.env['API_KEY'];
    const a = process.env['ADMIN_API_KEY'];
    if (!k || !a) {
      throw new Error('FATAL: Production API credentials (API_KEY and ADMIN_API_KEY) are strictly required.');
    }
    if (k.length < 32 || a.length < 32) {
      throw new Error('FATAL: API_KEY and ADMIN_API_KEY must each be at least 32 characters in production.');
    }
    if (k === a) {
      throw new Error('FATAL: API_KEY and ADMIN_API_KEY must be different.');
    }
  }
  const VALID_API_KEY = process.env['API_KEY'] ?? 'test-api-key';
  const ADMIN_API_KEY = process.env['ADMIN_API_KEY'] ?? 'admin-secret-key';

  const safeEqual = (a: string, b: string): boolean => {
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb);
  };

  // Operational / privileged endpoints: admin credential required.
  //   - reversing payments, accrual runs, period close/reopen/list, reconciliation
  const isAdminOnlyPath = (pathname: string): boolean =>
    pathname.startsWith('/accrual') ||
    pathname.startsWith('/periods') ||
    /^\/payments\/[^/]+\/reverse\/?$/.test(pathname);

  app.addHook('onRequest', async (req, reply) => {
    const pathname = req.url.split('?')[0] ?? '';
    // Health check is always public
    if (pathname === '/health' || pathname === '/health/') return;

    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['x-api-key'];
    const token =
      typeof apiKeyHeader === 'string'
        ? apiKeyHeader
        : typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7)
          : undefined;

    const isAdmin = token !== undefined && safeEqual(token, ADMIN_API_KEY);
    const isUser = token !== undefined && safeEqual(token, VALID_API_KEY);

    // Enforce authentication
    if (!isAdmin && !isUser) {
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Valid API key required via X-API-Key or Authorization: Bearer <key>',
      });
    }

    // Authorization: ONLY the server-side ADMIN_API_KEY grants administrative privileges.
    // (There is deliberately no client-supplied role header.)
    if (isAdminOnlyPath(pathname) && !isAdmin) {
      return reply.status(403).send({
        error: 'FORBIDDEN',
        message: 'Administrative credential required for this operation',
      });
    }
  });

  // Register route modules
  await app.register(loanRoutes, { prefix: '/loans' });
  await app.register(paymentRoutes, { prefix: '/payments' });
  await app.register(accrualRoutes, { prefix: '/accrual' });
  await app.register(periodRoutes, { prefix: '/periods' });
  await app.register(ledgerRoutes, { prefix: '/ledger' });

  // Global error handler with production detail sanitization
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const code = (err as { code?: string }).code ?? 'INTERNAL_ERROR';
    const message = status >= 500 && process.env['NODE_ENV'] === 'production'
      ? 'An internal financial ledger error occurred'
      : err.message;
    reply.status(status).send({ error: code, message });
  });

  return app;
}

export async function startServer() {
  const app = await buildApp();
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`🚀 Ledger API running on port ${port}`);
}
