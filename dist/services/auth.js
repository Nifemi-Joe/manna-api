/**
 * src/services/auth.ts
 * Magic-link auth, session management, permission resolution.
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
export function createMagicToken(userId) {
    const token = nanoid(48);
    const hash = hashToken(token);
    const expiresAt = new Date(Date.now() + MAGIC_EXPIRY_MINS * 60_000).toISOString();
    dbRun('INSERT INTO magic_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)', [nanoid(), userId, hash, expiresAt]);
    return token;
}
export function verifyMagicToken(token) {
    const hash = hashToken(token);
    const row = dbGet('SELECT * FROM magic_tokens WHERE token_hash = ?', [hash]);
    if (!row)
        return null;
    if (row.used_at)
        return null;
    if (new Date(row.expires_at) < new Date())
        return null;
    dbRun('UPDATE magic_tokens SET used_at = datetime(\'now\') WHERE id = ?', [row.id]);
    return { userId: row.user_id };
}
// ── Sessions ──────────────────────────────────────────────
export function createSession(userId, portal) {
    const sessionId = nanoid(64);
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();
    dbRun('INSERT INTO sessions (id, user_id, portal, expires_at) VALUES (?, ?, ?, ?)', [sessionId, userId, portal, expiresAt]);
    return sessionId;
}
export function getSession(sessionId) {
    const row = dbGet('SELECT user_id, portal, expires_at FROM sessions WHERE id = ?', [sessionId]);
    if (!row)
        return null;
    if (new Date(row.expires_at) < new Date()) {
        dbRun('DELETE FROM sessions WHERE id = ?', [sessionId]);
        return null;
    }
    // Touch last_seen
    dbRun('UPDATE sessions SET last_seen = datetime(\'now\') WHERE id = ?', [sessionId]);
    return { userId: row.user_id, portal: row.portal };
}
export function deleteSession(sessionId) {
    dbRun('DELETE FROM sessions WHERE id = ?', [sessionId]);
}
export function getUserById(id) {
    return dbGet('SELECT * FROM users WHERE id = ?', [id]);
}
export function getUserByEmail(email) {
    return dbGet('SELECT * FROM users WHERE email = ?', [email]);
}
// ── Permissions ───────────────────────────────────────────
export function getUserPermissions(userId) {
    const rows = dbAll(`SELECT DISTINCT p.key FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN role_assignments ra ON ra.role_id = rp.role_id
     WHERE ra.user_id = ? AND ra.status = 'active'`, [userId]);
    return rows.map(r => r.key);
}
export function getUserRoles(userId) {
    const rows = dbAll(`SELECT r.name FROM roles r
     JOIN role_assignments ra ON ra.role_id = r.id
     WHERE ra.user_id = ? AND ra.status = 'active'`, [userId]);
    return rows.map(r => r.name);
}
export function getCompanyByUserId(userId) {
    return dbGet(`SELECT c.id, c.name FROM companies c
     JOIN users u ON u.company_id = c.id
     WHERE u.id = ?`, [userId]);
}
// ── Format user for API response ─────────────────────────
export function formatUser(user) {
    const permissions = getUserPermissions(user.id);
    const roles = getUserRoles(user.id);
    const company = getCompanyByUserId(user.id);
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
