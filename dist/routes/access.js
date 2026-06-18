/**
 * src/routes/access.ts
 * GET  /api/v1/access/me
 * GET  /api/v1/access/permissions
 * GET  /api/v1/access/roles
 * POST /api/v1/access/roles
 * PATCH /api/v1/access/roles/:id
 * GET  /api/v1/access/assignments
 * POST /api/v1/access/assignments
 * PATCH /api/v1/access/assignments/:id
 */
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';
import { getUserById } from '../services/auth.js';
const createRoleSchema = z.object({
    name: z.string().min(1).max(80),
    description: z.string().optional(),
    permissions: z.array(z.string()),
});
const assignRoleSchema = z.object({
    userId: z.string(),
    roleId: z.string(),
});
const accessRoutes = async (fastify) => {
    // GET /api/v1/access/me
    fastify.get('/me', async (req) => {
        const user = await req.requireAuth();
        return user;
    });
    // GET /api/v1/access/permissions
    fastify.get('/permissions', async (req) => {
        await req.requireAuth();
        const rows = dbAll('SELECT id, key, label, grp FROM permissions ORDER BY grp, label');
        return {
            permissions: rows.map(r => ({
                id: r.id,
                key: r.key,
                label: r.label,
                group: r.grp,
            })),
        };
    });
    // GET /api/v1/access/roles
    fastify.get('/roles', async (req) => {
        await req.requirePermission('roles:read');
        const roles = dbAll(`SELECT id, name, description, created_at, updated_at FROM roles ORDER BY name`);
        const result = roles.map(r => {
            const perms = dbAll(`SELECT p.key FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         WHERE rp.role_id = ?`, [r.id]);
            const assigned = dbGet(`SELECT COUNT(*) as cnt FROM role_assignments WHERE role_id = ? AND status = 'active'`, [r.id]);
            return {
                id: r.id,
                name: r.name,
                description: r.description ?? undefined,
                permissions: perms.map(p => p.key),
                assignedCount: assigned?.cnt ?? 0,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
            };
        });
        return { roles: result };
    });
    // POST /api/v1/access/roles
    fastify.post('/roles', async (req, reply) => {
        await req.requirePermission('roles:write');
        const body = createRoleSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid role data', errors: body.error.flatten() });
        const { name, description, permissions } = body.data;
        const id = nanoid();
        const ts = new Date().toISOString();
        dbRun(`INSERT INTO roles (id, name, description, scope, created_at, updated_at) VALUES (?, ?, ?, 'company', ?, ?)`, [id, name, description ?? null, ts, ts]);
        for (const key of permissions) {
            const perm = dbGet('SELECT id FROM permissions WHERE key = ?', [key]);
            if (perm)
                dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [id, perm.id]);
        }
        const role = dbGet('SELECT * FROM roles WHERE id = ?', [id]);
        return reply.status(201).send({
            role: {
                id: role.id,
                name: role.name,
                description: description ?? undefined,
                permissions,
                assignedCount: 0,
                createdAt: role.created_at,
                updatedAt: role.updated_at,
            },
        });
    });
    // PATCH /api/v1/access/roles/:id
    fastify.patch('/roles/:id', async (req, reply) => {
        await req.requirePermission('roles:write');
        const { id } = req.params;
        const role = dbGet('SELECT id FROM roles WHERE id = ?', [id]);
        if (!role)
            return reply.status(404).send({ message: 'Role not found' });
        const body = createRoleSchema.partial().safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid data' });
        const { name, description, permissions } = body.data;
        const ts = new Date().toISOString();
        if (name)
            dbRun('UPDATE roles SET name = ?, updated_at = ? WHERE id = ?', [name, ts, id]);
        if (description !== undefined)
            dbRun('UPDATE roles SET description = ?, updated_at = ? WHERE id = ?', [description, ts, id]);
        if (permissions) {
            dbRun('DELETE FROM role_permissions WHERE role_id = ?', [id]);
            for (const key of permissions) {
                const perm = dbGet('SELECT id FROM permissions WHERE key = ?', [key]);
                if (perm)
                    dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [id, perm.id]);
            }
        }
        const updated = dbGet('SELECT * FROM roles WHERE id = ?', [id]);
        const perms = dbAll(`SELECT p.key FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = ?`, [id]);
        const assigned = dbGet(`SELECT COUNT(*) as cnt FROM role_assignments WHERE role_id = ? AND status = 'active'`, [id]);
        return {
            role: {
                id: updated.id,
                name: updated.name,
                description: updated.description ?? undefined,
                permissions: perms.map(p => p.key),
                assignedCount: assigned?.cnt ?? 0,
                createdAt: updated.created_at,
                updatedAt: updated.updated_at,
            },
        };
    });
    // GET /api/v1/access/assignments
    fastify.get('/assignments', async (req) => {
        await req.requirePermission('assignments:read');
        const rows = dbAll('SELECT * FROM role_assignments ORDER BY created_at DESC');
        return {
            assignments: rows.map(r => {
                const user = getUserById(r.user_id);
                const role = dbGet('SELECT name FROM roles WHERE id = ?', [r.role_id]);
                return {
                    id: r.id,
                    userId: r.user_id,
                    userName: user?.name ?? 'Unknown',
                    userEmail: user?.email ?? '',
                    roleId: r.role_id,
                    roleName: role?.name ?? '',
                    status: r.status,
                    assignedAt: r.created_at,
                    assignedBy: r.assigned_by,
                };
            }),
        };
    });
    // POST /api/v1/access/assignments
    fastify.post('/assignments', async (req, reply) => {
        await req.requirePermission('assignments:write');
        const caller = await req.requireAuth();
        const body = assignRoleSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid assignment data' });
        const { userId, roleId } = body.data;
        const user = getUserById(userId);
        if (!user)
            return reply.status(404).send({ message: 'User not found' });
        const role = dbGet('SELECT id, name FROM roles WHERE id = ?', [roleId]);
        if (!role)
            return reply.status(404).send({ message: 'Role not found' });
        const id = nanoid();
        dbRun(`INSERT INTO role_assignments (id, user_id, role_id, assigned_by, status)
       VALUES (?, ?, ?, ?, 'active')`, [id, userId, roleId, caller.id]);
        const row = dbGet('SELECT id, created_at FROM role_assignments WHERE id = ?', [id]);
        return reply.status(201).send({
            assignment: {
                id: row.id,
                userId,
                userName: user.name,
                userEmail: user.email,
                roleId,
                roleName: role.name,
                status: 'active',
                assignedAt: row.created_at,
                assignedBy: caller.id,
            },
        });
    });
    // PATCH /api/v1/access/assignments/:id
    fastify.patch('/assignments/:id', async (req, reply) => {
        await req.requirePermission('assignments:write');
        const { id } = req.params;
        const body = z.object({ status: z.enum(['active', 'inactive']) }).safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid status' });
        const row = dbGet('SELECT id FROM role_assignments WHERE id = ?', [id]);
        if (!row)
            return reply.status(404).send({ message: 'Assignment not found' });
        dbRun('UPDATE role_assignments SET status = ? WHERE id = ?', [body.data.status, id]);
        const updated = dbGet('SELECT * FROM role_assignments WHERE id = ?', [id]);
        const user = getUserById(updated.user_id);
        const role = dbGet('SELECT name FROM roles WHERE id = ?', [updated.role_id]);
        return {
            assignment: {
                id: updated.id,
                userId: updated.user_id,
                userName: user?.name ?? '',
                userEmail: user?.email ?? '',
                roleId: updated.role_id,
                roleName: role?.name ?? '',
                status: updated.status,
                assignedAt: updated.created_at,
                assignedBy: updated.assigned_by,
            },
        };
    });
};
export default accessRoutes;
