/**
 * src/routes/auth.ts
 * POST /api/v1/auth/request-link
 * GET  /api/v1/auth/verify?token=
 * POST /api/v1/auth/logout
 * POST /api/v1/auth/switch-context
 */
import { z } from 'zod';
import { getUserByEmail, createMagicToken, verifyMagicToken, createSession, deleteSession, formatUser, getUserById, SESSION_COOKIE } from '../services/auth.js';
import { sendMagicLink } from '../services/email.js';
import { dbRun } from '../db/index.js';
const COOKIE_OPTS = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
};
const requestLinkSchema = z.object({ email: z.string().email() });
const switchContextSchema = z.object({ portal: z.enum(['employee', 'hr', 'ops', 'admin', 'studio']) });
const authRoutes = async (fastify) => {
    // POST /api/v1/auth/request-link
    fastify.post('/request-link', async (req, reply) => {
        const body = requestLinkSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Valid email required' });
        const { email } = body.data;
        const user = await getUserByEmail(email);
        // Always return success to prevent email enumeration
        if (!user || user.status !== 'active') {
            return reply.send({ message: 'If that email is registered, a link has been sent.' });
        }
        const token = await createMagicToken(user.id);
        const link = await sendMagicLink(email, token);
        const response = {
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
        const { token } = req.query;
        if (!token)
            return reply.status(400).send({ message: 'Token required' });
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
        if (sid)
            await deleteSession(sid);
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.send({ success: true });
    });
    // POST /api/v1/auth/switch-context
    fastify.post('/switch-context', async (req, reply) => {
        const user = await req.requireAuth();
        const body = switchContextSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid portal' });
        const { portal } = body.data;
        // Update user's portal and rotate session
        await dbRun(`UPDATE users SET portal = $1, updated_at = now() WHERE id = $2`, [portal, user.id]);
        const oldSid = req.cookies?.[SESSION_COOKIE];
        if (oldSid)
            await deleteSession(oldSid);
        const sessionId = await createSession(user.id, portal);
        reply.setCookie(SESSION_COOKIE, sessionId, COOKIE_OPTS);
        return reply.send({ success: true });
    });
};
export default authRoutes;
