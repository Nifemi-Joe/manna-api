/**
 * src/routes/auth.ts
 * POST /api/v1/auth/request-link
 * GET  /api/v1/auth/verify?token=
 * POST /api/v1/auth/logout
 * POST /api/v1/auth/switch-context
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getUserByEmail, createMagicToken, verifyMagicToken, createSession, deleteSession, formatUser, getUserById, SESSION_COOKIE } from '../services/auth.js';
import { sendMagicLink } from '../services/email.js';
import { dbRun } from '../db/index.js';

const COOKIE_OPTS = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
};

/**
 * Controls whether the magic link itself is ever returned in the
 * /request-link API response (as `debugLink`).
 *
 * This is deliberately an explicit opt-in env var, NOT tied to NODE_ENV.
 * Reasoning: a deployed environment (Render, etc.) is `NODE_ENV=production`
 * but may still be a staging/test deployment without a verified sending
 * domain yet — and "is this real production with real users" isn't
 * something the app can infer from NODE_ENV alone. Defaulting this to
 * off and requiring a conscious env var keeps it from accidentally
 * leaking sign-in links once real users are on the platform.
 *
 * Set ALLOW_DEBUG_LOGIN_LINK=true on Render (or locally) to enable.
 */
const ALLOW_DEBUG_LOGIN_LINK = process.env.ALLOW_DEBUG_LOGIN_LINK === 'true';

const requestLinkSchema = z.object({ email: z.string().email() });
const switchContextSchema = z.object({ portal: z.enum(['employee', 'hr', 'ops', 'admin', 'studio']) });

const authRoutes: FastifyPluginAsync = async (fastify) => {

    // POST /api/v1/auth/request-link
    fastify.post('/request-link', async (req, reply) => {
        const body = requestLinkSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Valid email required' });

        const { email } = body.data;
        const user = await getUserByEmail(email);

        // Always return the same generic message to prevent email enumeration
        // — but only actually attempt a send (and possibly expose debugLink)
        // when a real, active account exists for this address.
        if (!user || user.status !== 'active') {
            return reply.send({ message: 'If that email is registered, a link has been sent.' });
        }

        const token = await createMagicToken(user.id);
        const result = await sendMagicLink(email, token);

        const response: Record<string, string> = {
            message: result.sent
                ? 'Magic link sent. Check your email.'
                : 'Could not send email right now — use the link below to sign in.',
        };

        // Expose the link directly when:
        //   - the operator has explicitly opted in via ALLOW_DEBUG_LOGIN_LINK, AND
        //   - either we're not in production, OR the real send failed (so the
        //     user isn't left completely unable to log in because of a
        //     delivery problem like an unverified domain).
        const shouldExposeLink =
            ALLOW_DEBUG_LOGIN_LINK && (process.env.NODE_ENV !== 'production' || !result.sent);

        if (shouldExposeLink) {
            response.debugLink = result.link;
            if (!result.sent && result.error) {
                response.debugReason = `Email delivery failed: ${result.error}`;
            }
        }

        return reply.send(response);
    });

    // GET /api/v1/auth/verify?token=
    fastify.get('/verify', async (req, reply) => {
        const { token } = req.query as { token?: string };
        if (!token) return reply.status(400).send({ message: 'Token required' });

        const result = await verifyMagicToken(token);
        if (!result) {
            return reply.status(401).send({ message: 'Token is invalid or has expired' });
        }

        const user = await getUserById(result.userId);
        if (!user || user.status !== 'active') {
            return reply.status(401).send({ message: 'Account not found or suspended' });
        }

        const sessionId = await createSession(user.id, user.portal);
        reply.setCookie(SESSION_COOKIE, sessionId, COOKIE_OPTS);

        const formatted = await formatUser(user);
        return reply.send({
            token: sessionId,
            user: formatted,
            portal: user.portal,
        });
    });

    // POST /api/v1/auth/logout
    fastify.post('/logout', async (req, reply) => {
        const sid = req.cookies?.[SESSION_COOKIE];
        if (sid) await deleteSession(sid);
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
        await dbRun(`UPDATE users SET portal = $1, updated_at = now() WHERE id = $2`, [portal, user.id]);

        const oldSid = req.cookies?.[SESSION_COOKIE];
        if (oldSid) await deleteSession(oldSid);

        const sessionId = await createSession(user.id, portal);
        reply.setCookie(SESSION_COOKIE, sessionId, COOKIE_OPTS);

        return reply.send({ success: true });
    });
};

export default authRoutes;