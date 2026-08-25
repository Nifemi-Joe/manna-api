/**
 * src/routes/notifications.ts
 * GET   /api/v1/notifications           (last 30, plus unread count)
 * PATCH /api/v1/notifications/:id/read
 * POST  /api/v1/notifications/read-all
 *
 * This is what the NotificationsBell dropdown now actually calls,
 * replacing its previous honest-but-empty local state.
 */

import type { FastifyPluginAsync } from 'fastify';
import { dbAll, dbGet, dbRun } from '../db/index.js';

function formatNotification(n: any) {
    return {
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        link: n.link ?? undefined,
        read: n.read_at != null,
        createdAt: n.created_at,
    };
}

const notificationsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/', async (req) => {
        const user = await req.requireAuth();

        const rows = await dbAll<any>(
            `SELECT * FROM notifications WHERE recipient_user_id = $1 ORDER BY created_at DESC LIMIT 30`,
            [user.id]
        );
        const unread = await dbGet<{ count: string }>(
            `SELECT COUNT(*) as count FROM notifications WHERE recipient_user_id = $1 AND read_at IS NULL`,
            [user.id]
        );

        return {
            notifications: rows.map(formatNotification),
            unreadCount: parseInt(unread?.count ?? '0', 10),
        };
    });

    fastify.patch('/:id/read', async (req, reply) => {
        const user = await req.requireAuth();
        const { id } = req.params as { id: string };

        const notification = await dbGet('SELECT id FROM notifications WHERE id = $1 AND recipient_user_id = $2', [id, user.id]);
        if (!notification) return reply.status(404).send({ message: 'Notification not found' });

        await dbRun(`UPDATE notifications SET read_at = now() WHERE id = $1`, [id]);
        return { success: true };
    });

    fastify.post('/read-all', async (req) => {
        const user = await req.requireAuth();
        await dbRun(`UPDATE notifications SET read_at = now() WHERE recipient_user_id = $1 AND read_at IS NULL`, [user.id]);
        return { success: true };
    });
};

export default notificationsRoutes;
