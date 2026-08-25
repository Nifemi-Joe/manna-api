/**
 * src/routes/notification-preferences.ts
 * GET   /api/v1/notification-preferences
 * PATCH /api/v1/notification-preferences
 *
 * Lets any signed-in user (employee, HR, ops, admin, studio) control
 * which notification kinds reach them and through which channel. This
 * is what "employees and HR should be able to select types of
 * notification they want" wires up to.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbRun } from '../db/index.js';

const KINDS = ['lead', 'issue', 'order', 'order_cancelled', 'order_delivered', 'order_swap_needed', 'system'] as const;

// Human-readable labels + which kinds are even relevant to which portal,
// so the frontend can show a sensible subset per person rather than
// every kind to everyone (an employee doesn't need a "new lead" toggle).
export const NOTIFICATION_KIND_META: Record<(typeof KINDS)[number], { label: string; portals: string[] }> = {
    lead: { label: 'New pilot requests', portals: ['admin'] },
    issue: { label: 'Issues & escalations', portals: ['ops', 'hr'] },
    order: { label: 'Order status updates', portals: ['employee', 'hr'] },
    order_cancelled: { label: 'Order cancelled', portals: ['employee', 'hr'] },
    order_delivered: { label: 'Order delivered', portals: ['employee', 'hr'] },
    order_swap_needed: { label: 'Meal unavailable — swap needed', portals: ['employee'] },
    system: { label: 'System announcements', portals: ['employee', 'hr', 'ops', 'admin', 'studio'] },
};

const updateSchema = z.object({
    preferences: z.array(z.object({
        kind: z.enum(KINDS),
        emailEnabled: z.boolean(),
        inAppEnabled: z.boolean(),
    })).min(1),
});

const notificationPreferencesRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/', async (req) => {
        const user = await req.requireAuth();

        const rows = await dbAll<any>(
            'SELECT notification_kind, email_enabled, in_app_enabled FROM notification_preferences WHERE user_id = $1',
            [user.id]
        );
        const overrides = new Map(rows.map((r) => [r.notification_kind, r]));

        const relevantKinds = KINDS.filter((k) => NOTIFICATION_KIND_META[k].portals.includes(user.portal));

        return {
            preferences: relevantKinds.map((kind) => {
                const override = overrides.get(kind);
                return {
                    kind,
                    label: NOTIFICATION_KIND_META[kind].label,
                    emailEnabled: override?.email_enabled ?? true,
                    inAppEnabled: override?.in_app_enabled ?? true,
                };
            }),
        };
    });

    fastify.patch('/', async (req, reply) => {
        const user = await req.requireAuth();

        const body = updateSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid preferences data', errors: body.error.flatten() });

        for (const p of body.data.preferences) {
            await dbRun(
                `INSERT INTO notification_preferences (id, user_id, notification_kind, email_enabled, in_app_enabled)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (user_id, notification_kind)
                 DO UPDATE SET email_enabled = $4, in_app_enabled = $5, updated_at = now()`,
                [nanoid(), user.id, p.kind, p.emailEnabled, p.inAppEnabled]
            );
        }

        return { success: true };
    });
};

export default notificationPreferencesRoutes;
