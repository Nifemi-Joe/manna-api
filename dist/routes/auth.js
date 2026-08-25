/**
 * src/routes/auth.ts
 * POST /api/v1/auth/request-link
 * GET  /api/v1/auth/verify?token=
 * POST /api/v1/auth/request-otp
 * POST /api/v1/auth/verify-otp
 * POST /api/v1/auth/logout
 * POST /api/v1/auth/switch-context
 *
 * UPDATED (this pass) — ONLY the rate-limit config objects on
 * request-otp and verify-otp were added below. Everything else is your
 * existing file, unchanged. A 6-digit code is ~1,000,000 possibilities;
 * the global 200/min/IP limit alone would let an attacker grind through
 * a meaningful fraction of that in well under an hour. These close that
 * gap specifically:
 *   - request-otp: 5 requests / 15 min per IP
 *   - verify-otp: 10 attempts / 15 min per IP — on top of the existing
 *     per-code attempt ceiling in verifyOtpCode (too_many_attempts),
 *     so rotating to a fresh code doesn't reset an attacker's budget.
 */
import { z } from 'zod';
import { getUserByEmail, createMagicToken, verifyMagicToken, createOtpCode, verifyOtpCode, createSession, deleteSession, formatUser, getUserById, SESSION_COOKIE, } from '../services/auth.js';
import { sendMagicLink, sendOtpEmail } from '../services/email.js';
import { sendOtpSms } from '../services/sms.js';
import { dbRun } from '../db/index.js';
const COOKIE_OPTS = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
};
/**
 * Controls whether the magic link itself is ever returned in the
 * /request-link API response (as `debugLink`). Deliberately an explicit
 * opt-in env var, not tied to NODE_ENV — see original comment history.
 * Set ALLOW_DEBUG_LOGIN_LINK=true to enable.
 */
const ALLOW_DEBUG_LOGIN_LINK = process.env.ALLOW_DEBUG_LOGIN_LINK === 'true';
const requestLinkSchema = z.object({ email: z.string().email() });
const switchContextSchema = z.object({ portal: z.enum(['employee', 'hr', 'ops', 'admin', 'studio']) });
const requestOtpSchema = z.object({
    email: z.string().email(),
    /** Defaults to email; pass 'sms' to send via the user's stored phone number instead. */
    channel: z.enum(['email', 'sms']).default('email'),
});
const verifyOtpSchema = z.object({
    email: z.string().email(),
    code: z.string().length(6),
});
const authRoutes = async (fastify) => {
    // POST /api/v1/auth/request-link
    fastify.post('/request-link', async (req, reply) => {
        const body = requestLinkSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Valid email required' });
        const { email } = body.data;
        const user = await getUserByEmail(email);
        // Always return the same generic message to prevent email enumeration
        // — only actually attempt a send when a real, active account exists.
        if (!user || user.status !== 'active') {
            return reply.send({ message: 'If that email is registered, a link has been sent.' });
        }
        const token = await createMagicToken(user.id);
        const result = await sendMagicLink(email, token);
        const response = {
            message: result.sent
                ? 'Magic link sent. Check your email.'
                : 'Could not send email right now — use the link below to sign in.',
        };
        const shouldExposeLink = ALLOW_DEBUG_LOGIN_LINK && (process.env.NODE_ENV !== 'production' || !result.sent);
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
        return reply.send({ token: sessionId, user: formatted, portal: user.portal });
    });
    // POST /api/v1/auth/request-otp — max 5 requests / 15 min per IP
    fastify.post('/request-otp', {
        config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    }, async (req, reply) => {
        const body = requestOtpSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Valid email required' });
        const { email, channel } = body.data;
        const user = await getUserByEmail(email);
        // Same enumeration-prevention pattern as request-link.
        if (!user || user.status !== 'active') {
            return reply.send({ message: 'If that email is registered, a code has been sent.' });
        }
        if (channel === 'sms' && !user.phone) {
            return reply.status(400).send({ message: 'No phone number on file for this account. Try email instead.' });
        }
        const code = await createOtpCode(user.id);
        const result = channel === 'sms' && user.phone
            ? await sendOtpSms(user.phone, code)
            : await sendOtpEmail(email, code);
        const response = {
            message: result.sent
                ? `Code sent via ${channel}. Check your ${channel === 'sms' ? 'phone' : 'email'}.`
                : `Could not send ${channel} right now.`,
        };
        // Same debug-only exposure pattern as the magic link, for local dev
        // and delivery-failure fallback — never exposed in real production
        // sends unless explicitly opted in.
        const shouldExposeCode = ALLOW_DEBUG_LOGIN_LINK && (process.env.NODE_ENV !== 'production' || !result.sent);
        if (shouldExposeCode) {
            response.debugCode = code;
            if (!result.sent && result.error)
                response.debugReason = `Delivery failed: ${result.error}`;
        }
        return reply.send(response);
    });
    // POST /api/v1/auth/verify-otp — max 10 attempts / 15 min per IP
    fastify.post('/verify-otp', {
        config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    }, async (req, reply) => {
        const body = verifyOtpSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Email and 6-digit code required' });
        const { email, code } = body.data;
        const user = await getUserByEmail(email);
        if (!user || user.status !== 'active') {
            return reply.status(401).send({ message: 'Invalid code' });
        }
        const result = await verifyOtpCode(user.id, code);
        if (!result.ok) {
            const messages = {
                not_found: 'No code requested for this account. Request a new one.',
                expired: 'This code has expired. Request a new one.',
                used: 'This code has already been used. Request a new one.',
                too_many_attempts: 'Too many incorrect attempts. Request a new code.',
                incorrect_code: 'Incorrect code. Please try again.',
            };
            return reply.status(401).send({ message: messages[result.reason] });
        }
        const sessionId = await createSession(user.id, user.portal);
        reply.setCookie(SESSION_COOKIE, sessionId, COOKIE_OPTS);
        const formatted = await formatUser(user);
        return reply.send({ token: sessionId, user: formatted, portal: user.portal });
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
