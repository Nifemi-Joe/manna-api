/**
 * src/routes/orders-swap.ts
 * POST /api/v1/orders/:id/swap
 *
 * The employee's half of the swap flow: given an order admin has
 * flagged with needs_swap=true and a set of alternatives, the employee
 * picks one. Reworks the ledger charge from scratch (refund the old
 * meal's charge, apply the new meal's charge) using the same
 * allowance→overspend→employee-pay logic as everywhere else. Cancelling
 * instead just reuses the existing PATCH /orders/:id/cancel endpoint —
 * no new code needed for that half.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { dbGet, dbRun } from '../db/index.js';

function toMoney(value: unknown, fallback = 0): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') { const p = parseFloat(value); return Number.isFinite(p) ? Math.round(p) : fallback; }
    return fallback;
}

async function resolveOverspendLimit(payerId: string, window: 'breakfast' | 'lunch'): Promise<number> {
    const payer = await dbGet<any>('SELECT level_id FROM users WHERE id = $1', [payerId]);
    if (!payer?.level_id) return 0;
    const level = await dbGet<any>('SELECT overspend_limit_lunch, overspend_limit_breakfast FROM staff_levels WHERE id = $1', [payer.level_id]);
    const limit = window === 'breakfast' ? level?.overspend_limit_breakfast : level?.overspend_limit_lunch;
    return toMoney(limit, 0);
}

const swapSchema = z.object({ newMealId: z.string() });

const ordersSwapRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/orders/:id/swap', async (req, reply) => {
        const user = await req.requireAuth();
        const { id } = req.params as { id: string };

        const order = await dbGet<any>('SELECT * FROM orders WHERE id = $1 AND (user_id = $2 OR ordered_by_user_id = $2)', [id, user.id]);
        if (!order) return reply.status(404).send({ message: 'Order not found' });
        if (!order.needs_swap) return reply.status(400).send({ message: 'This order isn\'t awaiting a swap' });

        const body = swapSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Choose an alternative meal' });

        const alternatives = typeof order.swap_alternatives === 'string' ? JSON.parse(order.swap_alternatives) : order.swap_alternatives;
        const chosen = alternatives.find((a: any) => a.id === body.data.newMealId);
        if (!chosen) return reply.status(400).send({ message: "That meal isn't one of the offered alternatives" });

        const newMeal = await dbGet<any>('SELECT * FROM meals WHERE id = $1 AND available = TRUE', [body.data.newMealId]);
        if (!newMeal) return reply.status(404).send({ message: 'That alternative is no longer available. Please pick another or cancel.' });

        const window: 'breakfast' | 'lunch' = order.meal_window === 'breakfast' ? 'breakfast' : 'lunch';
        const payerId = order.ordered_by_user_id ?? order.user_id;

        // 1. Refund the ledger for the old meal's allowance-covered amount.
        await dbRun(
            'UPDATE allowance_ledger SET used = GREATEST(0, used - $1) WHERE user_id = $2 AND date = $3 AND meal_window = $4',
            [toMoney(order.allowance_covered), payerId, order.date, window]
        );

        // 2. Recompute charge for the new meal against the now-refunded ledger.
        const ledger = await dbGet<{ amount: number; used: number }>(
            'SELECT amount, used FROM allowance_ledger WHERE user_id = $1 AND date = $2 AND meal_window = $3',
            [payerId, order.date, window]
        );
        const overspendLimit = await resolveOverspendLimit(payerId, window);
        const newTotal = toMoney(newMeal.price) * (order.quantity ?? 1);
        const remaining = Math.max(0, toMoney(ledger?.amount) - toMoney(ledger?.used));
        const coveredByBase = Math.min(newTotal, remaining);
        const coveredByOverspend = Math.min(newTotal - coveredByBase, overspendLimit);
        const allowanceCovered = coveredByBase + coveredByOverspend;
        const employeePaid = newTotal - allowanceCovered;

        await dbRun(
            `UPDATE orders SET meal_id = $1, meal_name = $2, total_amount = $3, allowance_covered = $4, overspend_covered = $5, employee_paid = $6,
                                needs_swap = FALSE, swap_alternatives = '[]', swap_reason = NULL, updated_at = now()
             WHERE id = $7`,
            [newMeal.id, newMeal.name, newTotal, allowanceCovered, coveredByOverspend, employeePaid, id]
        );

        await dbRun(
            'UPDATE allowance_ledger SET used = used + $1 WHERE user_id = $2 AND date = $3 AND meal_window = $4',
            [allowanceCovered, payerId, order.date, window]
        );

        const updated = await dbGet<any>('SELECT * FROM orders WHERE id = $1', [id]);
        return {
            order: {
                id: updated.id,
                mealName: updated.meal_name,
                totalAmount: toMoney(updated.total_amount),
                allowanceCovered: toMoney(updated.allowance_covered),
                employeePaid: toMoney(updated.employee_paid),
            },
            requiresTopUp: employeePaid > 0,
            topUpAmount: employeePaid > 0 ? employeePaid : undefined,
        };
    });
};

export default ordersSwapRoutes;
