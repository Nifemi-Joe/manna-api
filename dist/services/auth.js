/**
 * src/services/auth.ts
 * Magic-link + OTP auth, session management, permission resolution.
 */
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { dbGet, dbRun, dbAll } from '../db/index.js';
const SESSION_COOKIE = 'manna_session';
const SESSION_TTL_DAYS = 30;
const MAGIC_EXPIRY_MINS = parseInt(process.env.MAGIC_LINK_EXPIRY_MINUTES ?? '15', 10);
const OTP_EXPIRY_MINS = parseInt(process.env.OTP_EXPIRY_MINUTES ?? '10', 10);
const OTP_MAX_ATTEMPTS = 5;
// ── Token helpers ─────────────────────────────────────────
export function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}
// ── Magic link ────────────────────────────────────────────
export async function createMagicToken(userId) {
    const token = nanoid(48);
    const hash = hashToken(token);
    const expiresAt = new Date(Date.now() + MAGIC_EXPIRY_MINS * 60_000).toISOString();
    await dbRun('INSERT INTO magic_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [nanoid(), userId, hash, expiresAt]);
    return token;
}
export async function verifyMagicToken(token) {
    const hash = hashToken(token);
    const row = await dbGet('SELECT * FROM magic_tokens WHERE token_hash = $1', [hash]);
    if (!row)
        return null;
    if (row.used_at)
        return null;
    if (new Date(row.expires_at) < new Date())
        return null;
    await dbRun(`UPDATE magic_tokens SET used_at = now() WHERE id = $1`, [row.id]);
    return { userId: row.user_id };
}
// ── OTP (one-time code) ──────────────────────────────────
// Alternative to the magic link: a 6-digit code sent by email or SMS,
// entered directly on the login screen instead of clicking a link.
// Requires the `otp_codes` table — see
// db/migrations/002_pilot_and_meal_windows.ts.
function generateOtpCode() {
    // 6-digit numeric code, zero-padded (e.g. "042817")
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}
export async function createOtpCode(userId) {
    const code = generateOtpCode();
    const codeHash = hashToken(code);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINS * 60_000).toISOString();
    // Invalidate any previous unused codes for this user so only the most
    // recent one is valid — avoids a stale earlier code still working.
    await dbRun('DELETE FROM otp_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
    await dbRun('INSERT INTO otp_codes (id, user_id, code_hash, expires_at) VALUES ($1, $2, $3, $4)', [nanoid(), userId, codeHash, expiresAt]);
    return code;
}
/**
 * Verifies a code against the most recent unused OTP for that user.
 * Tracks attempts so a code can't be brute-forced (6 digits = 1M
 * possibilities, but without a limit that's still guessable quickly).
 */
export async function verifyOtpCode(userId, code) {
    const row = await dbGet('SELECT * FROM otp_codes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]);
    if (!row)
        return { ok: false, reason: 'not_found' };
    if (row.used_at)
        return { ok: false, reason: 'used' };
    if (new Date(row.expires_at) < new Date())
        return { ok: false, reason: 'expired' };
    if (row.attempts >= OTP_MAX_ATTEMPTS)
        return { ok: false, reason: 'too_many_attempts' };
    const providedHash = hashToken(code);
    if (providedHash !== row.code_hash) {
        await dbRun('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
        return { ok: false, reason: 'incorrect_code' };
    }
    await dbRun('UPDATE otp_codes SET used_at = now() WHERE id = $1', [row.id]);
    return { ok: true, userId };
}
// ── Sessions ──────────────────────────────────────────────
export async function createSession(userId, portal) {
    const sessionId = nanoid(64);
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();
    await dbRun('INSERT INTO sessions (id, user_id, portal, expires_at) VALUES ($1, $2, $3, $4)', [sessionId, userId, portal, expiresAt]);
    return sessionId;
}
export async function getSession(sessionId) {
    const row = await dbGet('SELECT user_id, portal, expires_at FROM sessions WHERE id = $1', [sessionId]);
    if (!row)
        return null;
    if (new Date(row.expires_at) < new Date()) {
        await dbRun('DELETE FROM sessions WHERE id = $1', [sessionId]);
        return null;
    }
    await dbRun(`UPDATE sessions SET last_seen = now() WHERE id = $1`, [sessionId]);
    return { userId: row.user_id, portal: row.portal };
}
export async function deleteSession(sessionId) {
    await dbRun('DELETE FROM sessions WHERE id = $1', [sessionId]);
}
export async function getUserById(id) {
    return dbGet('SELECT * FROM users WHERE id = $1', [id]);
}
export async function getUserByEmail(email) {
    return dbGet('SELECT * FROM users WHERE email = $1', [email]);
}
// ── Permissions ───────────────────────────────────────────
export async function getUserPermissions(userId) {
    const rows = await dbAll(`SELECT DISTINCT p.key FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN role_assignments ra ON ra.role_id = rp.role_id
     WHERE ra.user_id = $1 AND ra.status = 'active'`, [userId]);
    return rows.map(r => r.key);
}
export async function getUserRoles(userId) {
    const rows = await dbAll(`SELECT r.name FROM roles r
     JOIN role_assignments ra ON ra.role_id = r.id
     WHERE ra.user_id = $1 AND ra.status = 'active'`, [userId]);
    return rows.map(r => r.name);
}
export async function getCompanyByUserId(userId) {
    return dbGet(`SELECT c.id, c.name FROM companies c
     JOIN users u ON u.company_id = c.id
     WHERE u.id = $1`, [userId]);
}
// ── Format user for API response ─────────────────────────
export async function formatUser(user) {
    const [permissions, roles, company] = await Promise.all([
        getUserPermissions(user.id),
        getUserRoles(user.id),
        getCompanyByUserId(user.id),
    ]);
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar ?? undefined,
        portal: user.portal,
        companyId: user.company_id ?? undefined,
        companyName: company?.name,
        phone: user.phone ?? undefined,
        permissions,
        roles,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
    };
}
export { SESSION_COOKIE };
