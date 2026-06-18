/**
 * src/routes/auth.ts
 * POST /api/v1/auth/request-link
 * GET  /api/v1/auth/verify?token=
 * POST /api/v1/auth/logout
 * POST /api/v1/auth/switch-context
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { getUserByEmail, createMagicToken, verifyMagicToken, createSession, deleteSession, formatUser, getUserById, SESSION_COOKIE } from '../services/auth.js';
import { sendMagicLink } from '../services/email.js';
import { dbRun } from '../db';

const COOKIE_OPTS = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
};

const requestLinkSchema = z.object({ email: z.string().email() });
const switchContextSchema = z.object({ portal: z.enum(['employee', 'hr', 'ops', 'admin', 'studio']) });

const authRoutes: FastifyPluginAsync = async (fastify) => {

    // POST /api/v1/auth/request-link
    fastify.post('/request-link', async (req, reply) => {
        const body = requestLinkSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Valid email required' });

        const { email } = body.data;
        const user = getUserByEmail(email);

        // Always return success to prevent email enumeration
        if (!user || user.status !== 'active') {
            return reply.send({ message: 'If that email is registered, a link has been sent.' });
        }

        const token = createMagicToken(user.id);
        const link = await sendMagicLink(email, token);

        const response: Record<string, string> = {
            message: 'Magic link sent. Check your email.',
        };

        // In development, return the link directly for easy testing
        if (process.env.NODE_ENV !== 'production') {
            response.debugLink = link;
        }

        return reply.send(response);
    });

    // GET /api/v1/auth/verify?token=
    fastify.get('/verify', async (req, reply) => {
        const { token } = req.query as { token?: string };
        if (!token) return reply.status(400).send({ message: 'Token required' });

        const result = verifyMagicToken(token);
        if (!result) {
            return reply.status(401).send({ message: 'Token is invalid or has expired' });
        }

        const user = getUserById(result.userId);
        if (!user || user.status !== 'active') {
            return reply.status(401).send({ message: 'Account not found or suspended' });
        }

        const sessionId = createSession(user.id, user.portal);
        reply.setCookie(SESSION_COOKIE, sessionId, COOKIE_OPTS);

        const formatted = formatUser(user);
        return reply.send({
            token: sessionId,
            user: formatted,
            portal: user.portal,
        });
    });

    // POST /api/v1/auth/logout
    fastify.post('/logout', async (req, reply) => {
        const sid = req.cookies?.[SESSION_COOKIE];
        if (sid) deleteSession(sid);
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.send({ success: true });
    });

    // POST /api/v1/auth/switch-context
    fastify.post('/switch-context', async (req, reply) => {
        const user = await req.requireAuth();
        const body = switchContextSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid portal' });

        const { portal } = body.data;

        // Update user's portal and rotate session
        dbRun('UPDATE users SET portal = ?, updated_at = datetime(\'now\') WHERE id = ?', [portal, user.id]);

        const oldSid = req.cookies?.[SESSION_COOKIE];
        if (oldSid) deleteSession(oldSid);

        const sessionId = createSession(user.id, portal);
        reply.setCookie(SESSION_COOKIE, sessionId, COOKIE_OPTS);

        return reply.send({ success: true });
    });
};

export default authRoutes;