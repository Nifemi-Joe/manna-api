/**
 * src/index.ts
 * Manna API — Fastify application server
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
import hrRoutes from './routes/hr.js';
import opsRoutes from './routes/ops.js';
import adminRoutes, { healthRoute } from './routes/admin.js';
import studioRoutes from './routes/studio.js';
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const isDev = process.env.NODE_ENV !== 'production';
async function build() {
    const app = Fastify({
        logger: {
            level: isDev ? 'info' : 'warn',
            ...(isDev ? {
                transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } },
            } : {}),
        },
        disableRequestLogging: !isDev,
    });
    // ── Security ──────────────────────────────────────────────
    await app.register(helmet, {
        contentSecurityPolicy: false, // API only — no HTML
        crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow CDN/browser fetch
    });
    // ── CORS ──────────────────────────────────────────────────
    await app.register(cors, {
        origin: [
            '*',
            'http://127.0.0.1:3000',
            ...(process.env.APP_URL ? [process.env.APP_URL] : []),
        ],
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
    });
    // ── Rate limiting ─────────────────────────────────────────
    await app.register(rateLimit, {
        max: 200,
        timeWindow: '1 minute',
        errorResponseBuilder: () => ({ statusCode: 429, message: 'Too many requests' }),
    });
    // ── Cookies ───────────────────────────────────────────────
    await app.register(cookie, {
        secret: process.env.SESSION_SECRET ?? 'dev-secret-change-in-production-32c',
        parseOptions: { httpOnly: true, sameSite: 'lax' },
    });
    // ── Multipart (file uploads) ──────────────────────────────
    await app.register(multipart, {
        limits: {
            fileSize: parseInt(process.env.MAX_UPLOAD_MB ?? '10', 10) * 1024 * 1024,
        },
    });
    // ── Static uploads ────────────────────────────────────────
    const uploadsDir = process.env.UPLOADS_DIR ?? './uploads';
    if (!fs.existsSync(uploadsDir))
        fs.mkdirSync(uploadsDir, { recursive: true });
    // Serve uploaded files
    app.get('/uploads/:filename', async (req, reply) => {
        const { filename } = req.params;
        const filepath = path.join(uploadsDir, path.basename(filename)); // prevent traversal
        if (!fs.existsSync(filepath))
            return reply.status(404).send({ message: 'File not found' });
        const stream = fs.createReadStream(filepath);
        return reply.send(stream);
    });
    // ── Auth plugin (session decorator) ──────────────────────
    await app.register(authPlugin);
    // ── Error handler ─────────────────────────────────────────
    app.setErrorHandler((error, req, reply) => {
        const err = error;
        const statusCode = err.statusCode ?? 500;
        const message = err.message ?? 'Internal server error';
        if (statusCode >= 500) {
            app.log.error({ err: error, url: req.url }, 'Internal error');
        }
        reply.status(statusCode).send({ statusCode, message });
    });
    // ── Routes ────────────────────────────────────────────────
    const PREFIX = '/api/v1';
    // Health — public endpoint at /api/v1/health
    await app.register(healthRoute, { prefix: PREFIX });
    // Auth
    await app.register(authRoutes, { prefix: `${PREFIX}/auth` });
    // Access / RBAC
    await app.register(accessRoutes, { prefix: `${PREFIX}/access` });
    // Employee (menus + orders endpoints at different paths)
    await app.register(employeeRoutes, { prefix: PREFIX });
    // HR
    await app.register(hrRoutes, { prefix: `${PREFIX}/hr` });
    // Ops
    await app.register(opsRoutes, { prefix: `${PREFIX}/ops` });
    // Admin (companies, users) - health is registered above at PREFIX level
    await app.register(adminRoutes, { prefix: `${PREFIX}/admin` });
    // Studio
    await app.register(studioRoutes, { prefix: `${PREFIX}/studio` });
    // 404 handler
    app.setNotFoundHandler((req, reply) => {
        reply.status(404).send({ statusCode: 404, message: `Route ${req.method} ${req.url} not found` });
    });
    return app;
}
async function main() {
    // Init DB
    await initDb();
    runMigrations();
    console.log('✓ Database ready');
    const app = await build();
    try {
        await app.listen({ port: PORT, host: HOST });
        console.log(`\n🍱 Manna API running on http://${HOST}:${PORT}`);
        console.log(`   Env:   ${process.env.NODE_ENV ?? 'development'}`);
        console.log(`   DB:    ${process.env.DB_PATH ?? './data/manna.db'}\n`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
main();
