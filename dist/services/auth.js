/**
 * src/services/auth.ts
 * Magic-link auth, session management, permission resolution.
 * Converted to Postgres (async, $N placeholders).
 */
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { dbGet, dbRun, dbAll } from '../db/index.js';
const SESSION_COOKIE = 'manna_session';
const SESSION_TTL_DAYS = 30;
const MAGIC_EXPIRY_MINS = parseInt(process.env.MAGIC_LINK_EXPIRY_MINUTES ?? '15', 10);
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
    // Touch last_seen
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
// NOTE: now async because it fans out to three queries. Every call site
// (plugins/auth.ts, routes/auth.ts, routes/access.ts) must `await` this.
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
        permissions,
        roles,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
    };
}
export { SESSION_COOKIE };
