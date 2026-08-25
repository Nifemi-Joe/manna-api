/**
 * src/index.ts
 * Manna API — Fastify application server
 *
 * UPDATED: three new route groups registered — admin-orders,
 * orders-swap, notification-preferences.
 */

import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import path from 'node:path';
import fs from 'node:fs';

import { initDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import authPlugin from './plugins/auth.js';

import authRoutes from './routes/auth.js';
import accessRoutes from './routes/access.js';
import employeeRoutes from './routes/employee.js';
import ordersSwapRoutes from './routes/orders-swap.js';
import hrRoutes from './routes/hr.js';
import opsRoutes from './routes/ops.js';
import adminRoutes, { healthRoute } from './routes/admin.js';
import adminOrdersRoutes from './routes/admin-orders.js';
import studioRoutes from './routes/studio.js';
import webhookRoutes from './routes/webhooks.js';
import { publicLeadRoutes, adminLeadRoutes } from './routes/leads.js';
import hrBulkUploadRoutes from './routes/hr-employees-bulk.js';
import hrEmployeeAllowanceRoutes from './routes/hr-employee-allowance.js';
import hrLevelsRoutes from './routes/hr-levels.js';
import notificationsRoutes from './routes/notifications.js';
import notificationPreferencesRoutes from './routes/notification-preferences.js';
import opsMealsRoutes from './routes/ops-meals.js';
import hrHolidaysRoutes from './routes/hr-holidays.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const isDev = process.env.NODE_ENV !== 'production';

async function build() {
    const app = Fastify({
        logger: {
            level: isDev ? 'info' : 'warn',
            ...(isDev ? { transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } } } : {}),
        },
        disableRequestLogging: !isDev,
    });

    await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });

    await app.register(cors, {
        origin: ['http://localhost:3000', 'http://127.0.0.1:3000', ...(process.env.APP_URL ? [process.env.APP_URL] : [])],
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
    });

    await app.register(rateLimit, {
        global: true,
        max: 200,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({ statusCode: 429, message: 'Too many requests — please wait a moment and try again.' }),
    });

    await app.register(cookie, {
        secret: process.env.SESSION_SECRET ?? 'dev-secret-change-in-production-32c',
        parseOptions: { httpOnly: true, sameSite: 'lax' },
    });

    await app.register(multipart, { limits: { fileSize: parseInt(process.env.MAX_UPLOAD_MB ?? '10', 10) * 1024 * 1024 } });

    const uploadsDir = process.env.UPLOADS_DIR ?? './uploads';
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    app.get('/uploads/:filename', async (req, reply) => {
        const { filename } = req.params as { filename: string };
        const filepath = path.join(uploadsDir, path.basename(filename));
        if (!fs.existsSync(filepath)) return reply.status(404).send({ message: 'File not found' });
        return reply.send(fs.createReadStream(filepath));
    });

    await app.register(authPlugin);

    app.setErrorHandler((error: any, req, reply) => {
        const statusCode = error?.statusCode ?? 500;
        const message = error?.message ?? 'Internal server error';
        if (statusCode >= 500) app.log.error({ err: error, url: req.url }, 'Internal error');
        reply.status(statusCode).send({ statusCode, message });
    });

    const PREFIX = '/api/v1';

    await app.register(healthRoute, { prefix: PREFIX });
    await app.register(authRoutes, { prefix: `${PREFIX}/auth` });
    await app.register(accessRoutes, { prefix: `${PREFIX}/access` });
    await app.register(employeeRoutes, { prefix: PREFIX });
    await app.register(ordersSwapRoutes, { prefix: PREFIX });
    await app.register(hrRoutes, { prefix: `${PREFIX}/hr` });
    await app.register(hrBulkUploadRoutes, { prefix: `${PREFIX}/hr` });
    await app.register(hrEmployeeAllowanceRoutes, { prefix: `${PREFIX}/hr` });
    await app.register(hrLevelsRoutes, { prefix: `${PREFIX}/hr` });
    await app.register(hrHolidaysRoutes, { prefix: `${PREFIX}/hr` });
    await app.register(opsRoutes, { prefix: `${PREFIX}/ops` });
    await app.register(opsMealsRoutes, { prefix: `${PREFIX}/ops` });
    await app.register(adminRoutes, { prefix: `${PREFIX}/admin` });
    await app.register(adminOrdersRoutes, { prefix: `${PREFIX}/admin` });
    await app.register(studioRoutes, { prefix: `${PREFIX}/studio` });
    await app.register(webhookRoutes, { prefix: `${PREFIX}/webhooks` });
    await app.register(publicLeadRoutes, { prefix: `${PREFIX}/leads` });
    await app.register(adminLeadRoutes, { prefix: `${PREFIX}/admin/leads` });
    await app.register(notificationsRoutes, { prefix: `${PREFIX}/notifications` });
    await app.register(notificationPreferencesRoutes, { prefix: `${PREFIX}/notification-preferences` });

    app.setNotFoundHandler((req, reply) => {
        reply.status(404).send({ statusCode: 404, message: `Route ${req.method} ${req.url} not found` });
    });

    return app;
}

async function main() {
    await initDb();
    await runMigrations();
    console.log('✓ Database ready');

    const app = await build();

    try {
        await app.listen({ port: PORT, host: HOST });
        console.log(`\n🍱 Manna API running on http://${HOST}:${PORT}`);
        console.log(`   Env:   ${process.env.NODE_ENV ?? 'development'}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

main();
