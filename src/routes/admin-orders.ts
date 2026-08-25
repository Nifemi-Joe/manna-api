/**
 * src/routes/admin-orders.ts
 * GET   /api/v1/admin/orders
 * PATCH /api/v1/admin/orders/:id/status
 * POST  /api/v1/admin/meals/:mealId/flag-unavailable
 *
 * Platform-wide order visibility and status control for admins — this
 * is the actual answer to "so they should be able to see all orders,
 * accept them, and change status." Every status change fans out an
 * in-app notification to the affected employee (and HR, and the payer
 * if delegated); cancelled/delivered additionally trigger an email,
 * gated by each recipient's own preference.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { dbAll, dbGet, dbRun } from '../db/index.js';
import { notifyUsers } from '../services/notifications.js';
import { sendOrderCancelledEmail, sendOrderDeliveredEmail, sendSwapNeededEmail } from '../services/email.js';

const ORDER_STATUSES = ['pending', 'confirmed', 'packed', 'dispatched', 'delivered', 'cancelled', 'failed'] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];

const updateStatusSchema = z.object({ status: z.enum(ORDER_STATUSES) });

const flagUnavailableSchema = z.object({
    alternativeMealIds: z.array(z.string()).min(1, 'Suggest at least one alternative'),
    reason: z.string().optional(),
});

function toMoney(value: unknown, fallback = 0): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') { const p = parseFloat(value); return Number.isFinite(p) ? Math.round(p) : fallback; }
    return fallback;
}

function formatAdminOrder(o: any) {
    return {
        id: o.id,
        recipientName: o.recipient_name,
        recipientEmail: o.recipient_email,
        payerName: o.payer_name,
        isDelegated: o.ordered_by_user_id != null && o.ordered_by_user_id !== o.user_id,
        companyName: o.company_name,
        mealName: o.meal_name,
        quantity: o.quantity ?? 1,
        mealWindow: o.meal_window,
        date: o.date,
        status: o.status,
        totalAmount: toMoney(o.total_amount),
        allowanceCovered: toMoney(o.allowance_covered),
        overspendCovered: toMoney(o.overspend_covered),
        employeePaid: toMoney(o.employee_paid),
        needsSwap: o.needs_swap === true,
        createdAt: o.created_at,
    };
}

const adminOrdersRoutes: FastifyPluginAsync = async (fastify) => {
    // GET /api/v1/admin/orders?status=&date=&companyId=
    fastify.get('/orders', async (req) => {
        await req.requirePermission('orders:read');
        const query = req.query as Record<string, string>;

        const conditions: string[] = [];
        const params: unknown[] = [];
        if (query.status) { params.push(query.status); conditions.push(`o.status = $${params.length}`); }
        if (query.date) { params.push(query.date); conditions.push(`o.date = $${params.length}`); }
        if (query.companyId) { params.push(query.companyId); conditions.push(`o.company_id = $${params.length}`); }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const rows = await dbAll<any>(
            `SELECT o.*, recipient.name as recipient_name, recipient.email as recipient_email,
                    payer.name as payer_name, c.name as company_name
             FROM orders o
                      JOIN users recipient ON recipient.id = o.user_id
                      JOIN users payer ON payer.id = o.ordered_by_user_id
                      JOIN companies c ON c.id = o.company_id
                 ${where}
             ORDER BY o.created_at DESC LIMIT 200`,
            params
        );

        return { orders: rows.map(formatAdminOrder) };
    });

    // PATCH /api/v1/admin/orders/:id/status
    fastify.patch('/orders/:id/status', async (req, reply) => {
        await req.requirePermission('orders:read');
        const { id } = req.params as { id: string };

        const body = updateStatusSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid status', errors: body.error.flatten() });

        const order = await dbGet<any>(
            `SELECT o.*, recipient.name as recipient_name, recipient.email as recipient_email, payer.id as payer_id
             FROM orders o
                      JOIN users recipient ON recipient.id = o.user_id
                      JOIN users payer ON payer.id = o.ordered_by_user_id
             WHERE o.id = $1`,
            [id]
        );
        if (!order) return reply.status(404).send({ message: 'Order not found' });

        const newStatus: OrderStatus = body.data.status;
        await dbRun(`UPDATE orders SET status = $1, updated_at = now() WHERE id = $2`, [newStatus, id]);

        // If cancelling, refund the allowance ledger — same behavior as
        // the employee-initiated cancel path.
        if (newStatus === 'cancelled' && order.status !== 'cancelled') {
            const window = order.meal_window === 'breakfast' ? 'breakfast' : 'lunch';
            const payerId = order.ordered_by_user_id ?? order.user_id;
            await dbRun(
                'UPDATE allowance_ledger SET used = GREATEST(0, used - $1) WHERE user_id = $2 AND date = $3 AND meal_window = $4',
                [toMoney(order.allowance_covered), payerId, order.date, window]
            );
        }

        // Notify the recipient in-app for EVERY status change (this is
        // the "employees should see it in app" part); email only fires
        // for cancelled/delivered specifically, per-recipient preference.
        const recipients = new Set([order.user_id]);
        if (order.payer_id && order.payer_id !== order.user_id) recipients.add(order.payer_id);

        if (newStatus === 'cancelled') {
            await notifyUsers(Array.from(recipients), {
                kind: 'order_cancelled',
                title: `Order cancelled — ${order.meal_name}`,
                body: `Your order for ${order.date} has been cancelled.`,
                link: '/employee/orders',
                emailFn: (email, name) => sendOrderCancelledEmail(email, name, { mealName: order.meal_name, date: order.date, orderId: order.id }),
            });
        } else if (newStatus === 'delivered') {
            await notifyUsers(Array.from(recipients), {
                kind: 'order_delivered',
                title: `Delivered — ${order.meal_name}`,
                body: `Your order for ${order.date} has arrived.`,
                link: '/employee/orders',
                emailFn: (email, name) => sendOrderDeliveredEmail(email, name, { mealName: order.meal_name, date: order.date, orderId: order.id }),
            });
        } else {
            const statusLabel: Record<OrderStatus, string> = {
                pending: 'Pending', confirmed: 'Confirmed', packed: 'Packed',
                dispatched: 'On its way', delivered: 'Delivered', cancelled: 'Cancelled', failed: 'Failed',
            };
            await notifyUsers(Array.from(recipients), {
                kind: 'order',
                title: `${statusLabel[newStatus]} — ${order.meal_name}`,
                body: `Your order for ${order.date} is now ${statusLabel[newStatus].toLowerCase()}.`,
                link: '/employee/orders',
            });
        }

        // Also let HR know, in-app only — they don't need an email flood
        // for every status change, just visibility.
        const hrUsers = await dbAll<{ id: string }>(`SELECT id FROM users WHERE portal = 'hr' AND company_id = $1 AND status = 'active'`, [order.company_id]);
        if (hrUsers.length > 0) {
            await notifyUsers(hrUsers.map((u) => u.id), {
                kind: 'order',
                title: `${order.recipient_name}'s order — ${newStatus}`,
                body: `${order.meal_name} for ${order.date}`,
                link: '/hr/orders',
            });
        }

        return { success: true, status: newStatus };
    });

    // POST /api/v1/admin/meals/:mealId/flag-unavailable — the "meal
    // just ran out" flow. Marks the meal unavailable, finds every
    // today's-still-open order referencing it, attaches the suggested
    // alternatives, and notifies each affected employee in-app + email.
    fastify.post('/meals/:mealId/flag-unavailable', async (req, reply) => {
        await req.requirePermission('menus:write');
        const { mealId } = req.params as { mealId: string };

        const body = flagUnavailableSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid data', errors: body.error.flatten() });

        const meal = await dbGet<any>('SELECT * FROM meals WHERE id = $1', [mealId]);
        if (!meal) return reply.status(404).send({ message: 'Meal not found' });

        const alternatives = await dbAll<any>(
            `SELECT id, name, price FROM meals WHERE id = ANY($1) AND available = TRUE`,
            [body.data.alternativeMealIds]
        );
        if (alternatives.length === 0) return reply.status(400).send({ message: 'None of the selected alternatives are currently available' });

        await dbRun(`UPDATE meals SET available = FALSE, updated_at = now() WHERE id = $1`, [mealId]);

        const today = new Date().toISOString().slice(0, 10);
        const affectedOrders = await dbAll<any>(
            `SELECT o.*, recipient.name as recipient_name, recipient.email as recipient_email
             FROM orders o
                      JOIN users recipient ON recipient.id = o.user_id
             WHERE o.meal_id = $1 AND o.date = $2 AND o.status NOT IN ('delivered', 'cancelled')`,
            [mealId, today]
        );

        const altPayload = alternatives.map((a) => ({ id: a.id, name: a.name, price: toMoney(a.price) }));

        for (const order of affectedOrders) {
            await dbRun(
                `UPDATE orders SET needs_swap = TRUE, swap_alternatives = $1, swap_reason = $2, updated_at = now() WHERE id = $3`,
                [JSON.stringify(altPayload), body.data.reason ?? `${meal.name} is no longer available`, order.id]
            );

            await notifyUsers([order.user_id], {
                kind: 'order_swap_needed',
                title: `Action needed — ${meal.name} is unavailable`,
                body: `Choose an alternative for your ${order.date} order, or cancel it.`,
                link: '/employee/orders',
                emailFn: (email, name) => sendSwapNeededEmail(email, name, {
                    mealName: meal.name,
                    date: order.date,
                    alternatives: altPayload,
                    orderUrl: `${process.env.APP_URL}/employee/orders`,
                }),
            });
        }

        return {
            success: true,
            affectedOrderCount: affectedOrders.length,
            alternatives: altPayload,
        };
    });
};

export default adminOrdersRoutes;
