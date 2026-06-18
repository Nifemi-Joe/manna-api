/**
 * src/routes/employee.ts
 * GET  /api/v1/menus
 * GET  /api/v1/employee/allowance
 * GET  /api/v1/orders/me
 * POST /api/v1/orders
 * PATCH /api/v1/orders/:id/cancel
 * POST /api/v1/payments/paystack/initialize
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';

const placeOrderSchema = z.object({
    mealId: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().optional(),
});

const topUpSchema = z.object({
    amount: z.number().positive(),
    orderId: z.string().optional(),
});

const employeeRoutes: FastifyPluginAsync = async (fastify) => {

    // GET /api/v1/menus — current week's published menu
    fastify.get('/menus', async (req, reply) => {
        await req.requireAuth();

        // Find the published menu for the current or upcoming week
        const menu = dbGet<{ id: string; week_start: string }>(
            `SELECT id, week_start FROM menus WHERE published = 1
       ORDER BY week_start DESC LIMIT 1`
        );

        if (!menu) {
            return reply.status(404).send({ message: 'No menu published yet' });
        }

        const days = dbAll<{ date: string; cutoff_time: string; meal_id: string }>(
            `SELECT date, cutoff_time, meal_id
       FROM menu_meals WHERE menu_id = ?
       ORDER BY date, meal_id`,
            [menu.id]
        );

        // Group by date
        const dateMap = new Map<string, { date: string; cutoffTime: string; meals: any[] }>();
        for (const row of days) {
            if (!dateMap.has(row.date)) {
                dateMap.set(row.date, { date: row.date, cutoffTime: row.cutoff_time, meals: [] });
            }

            const meal = dbGet<any>('SELECT * FROM meals WHERE id = ? AND available = 1', [row.meal_id]);
            if (meal) {
                dateMap.get(row.date)!.meals.push({
                    id: meal.id,
                    name: meal.name,
                    description: meal.description,
                    price: meal.price,
                    spiceLevel: meal.spice_level,
                    allergens: JSON.parse(meal.allergens ?? '[]'),
                    dietary: JSON.parse(meal.dietary ?? '[]'),
                    imageUrl: meal.image_url ?? undefined,
                    available: meal.available === 1,
                });
            }
        }

        return {
            week: menu.week_start,
            days: Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
        };
    });

    // GET /api/v1/employee/allowance
    fastify.get('/employee/allowance', async (req) => {
        const user = await req.requireAuth();
        if (!user.companyId) return { dailyAmount: 0, remaining: 0, used: 0, resetAt: '', mealType: 'lunch' };

        const rules = dbGet<any>(
            'SELECT * FROM allowance_rules WHERE company_id = ?',
            [user.companyId]
        );

        const today = new Date().toISOString().slice(0, 10);
        const resetAt = `${today}T23:59:59.999Z`;

        // Get or create today's ledger entry
        let ledger = dbGet<{ amount: number; used: number }>(
            'SELECT amount, used FROM allowance_ledger WHERE user_id = ? AND date = ?',
            [user.id, today]
        );

        if (!ledger) {
            const amount = rules?.daily_amount ?? 2500;
            dbRun(
                `INSERT OR IGNORE INTO allowance_ledger (id, user_id, date, amount, used, reset_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
                [nanoid(), user.id, today, amount, resetAt]
            );
            ledger = { amount: amount, used: 0 };
        }

        const daily = rules?.daily_amount ?? 2500;

        return {
            dailyAmount: daily,
            daily,
            remaining: Math.max(0, ledger.amount - ledger.used),
            used: ledger.used,
            resetAt,
            mealType: rules?.meal_type ?? 'lunch',
        };
    });

    // GET /api/v1/orders/me
    fastify.get('/orders/me', async (req) => {
        const user = await req.requireAuth();

        const orders = dbAll<any>(
            `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
            [user.id]
        );

        return {
            orders: orders.map(formatOrder),
            total: orders.length,
            page: 1,
            perPage: 50,
        };
    });

    // POST /api/v1/orders
    fastify.post('/orders', async (req, reply) => {
        const user = await req.requirePermission('orders:create');

        const body = placeOrderSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid order data', errors: body.error.flatten() });

        const { mealId, date, notes } = body.data;
        if (!user.companyId) return reply.status(403).send({ message: 'No company associated with account' });

        // Validate meal exists and is in the menu for that date
        const meal = dbGet<any>('SELECT * FROM meals WHERE id = ? AND available = 1', [mealId]);
        if (!meal) return reply.status(404).send({ message: 'Meal not found or unavailable' });

        // Check cutoff hasn't passed
        const menuMeal = dbGet<any>(
            `SELECT mm.cutoff_time FROM menu_meals mm
       JOIN menus m ON m.id = mm.menu_id
       WHERE mm.meal_id = ? AND mm.date = ? AND m.published = 1`,
            [mealId, date]
        );
        if (!menuMeal) return reply.status(400).send({ message: 'Meal not available on this date' });
        if (new Date() > new Date(menuMeal.cutoff_time)) {
            return reply.status(400).send({ message: 'Order cutoff has passed for this date' });
        }

        // Check duplicate order
        const existing = dbGet(
            'SELECT id FROM orders WHERE user_id = ? AND date = ? AND status != ?',
            [user.id, date, 'cancelled']
        );
        if (existing) return reply.status(409).send({ message: 'You already have an order for this date' });

        // Get allowance
        const rules = dbGet<any>('SELECT * FROM allowance_rules WHERE company_id = ?', [user.companyId]);
        const dailyAllowance = rules?.daily_amount ?? 0;
        const today = new Date().toISOString().slice(0, 10);
        let ledger = dbGet<{ amount: number; used: number }>(
            'SELECT amount, used FROM allowance_ledger WHERE user_id = ? AND date = ?',
            [user.id, today]
        );
        if (!ledger) {
            const resetAt = `${today}T23:59:59.999Z`;
            dbRun(
                `INSERT OR IGNORE INTO allowance_ledger (id, user_id, date, amount, used, reset_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
                [nanoid(), user.id, today, dailyAllowance, resetAt]
            );
            ledger = { amount: dailyAllowance, used: 0 };
        }

        const remaining = Math.max(0, ledger.amount - ledger.used);
        const allowanceCovered = Math.min(meal.price, remaining);
        const employeePaid = meal.price - allowanceCovered;

        const orderId = nanoid();
        const company = dbGet<any>('SELECT address FROM companies WHERE id = ?', [user.companyId]);

        dbRun(
            `INSERT INTO orders (id, user_id, company_id, meal_id, meal_name, date, status, total_amount, allowance_covered, employee_paid, delivery_address, notes, cancellable)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1)`,
            [orderId, user.id, user.companyId, mealId, meal.name, date, meal.price, allowanceCovered, employeePaid, company?.address ?? '', notes ?? null]
        );

        // Create delivery record
        dbRun(
            `INSERT INTO deliveries (id, order_id, company_id, status, delivery_address, scheduled_for)
       VALUES (?, ?, ?, 'scheduled', ?, ?)`,
            [nanoid(), orderId, user.companyId, company?.address ?? '', `${date}T12:30:00.000Z`]
        );

        // Deduct from allowance ledger
        dbRun(
            'UPDATE allowance_ledger SET used = used + ? WHERE user_id = ? AND date = ?',
            [allowanceCovered, user.id, today]
        );

        const order = dbGet<any>('SELECT * FROM orders WHERE id = ?', [orderId]);

        const requiresTopUp = employeePaid > 0;
        const response: any = {
            order: formatOrder(order!),
            requiresTopUp,
        };

        if (requiresTopUp) {
            response.topUpAmount = employeePaid;
            response.paymentUrl = `${process.env.APP_URL}/pay?orderId=${orderId}`;
        }

        return reply.status(201).send(response);
    });

    // PATCH /api/v1/orders/:id/cancel
    fastify.patch('/orders/:id/cancel', async (req, reply) => {
        const user = await req.requirePermission('orders:cancel');
        const { id } = req.params as { id: string };

        const order = dbGet<any>('SELECT * FROM orders WHERE id = ? AND user_id = ?', [id, user.id]);
        if (!order) return reply.status(404).send({ message: 'Order not found' });
        if (!order.cancellable) return reply.status(400).send({ message: 'Order cannot be cancelled' });
        if (['cancelled', 'delivered'].includes(order.status)) {
            return reply.status(400).send({ message: `Order is already ${order.status}` });
        }

        dbRun(
            `UPDATE orders SET status = 'cancelled', cancellable = 0, updated_at = datetime('now') WHERE id = ?`,
            [id]
        );

        // Refund allowance
        const today = new Date().toISOString().slice(0, 10);
        dbRun(
            'UPDATE allowance_ledger SET used = MAX(0, used - ?) WHERE user_id = ? AND date = ?',
            [order.allowance_covered, user.id, today]
        );

        return { success: true };
    });

    // POST /api/v1/payments/paystack/initialize
    fastify.post('/payments/paystack/initialize', async (req, reply) => {
        const user = await req.requireAuth();

        const body = topUpSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid top-up data' });

        const reference = `MANNA-${nanoid(12).toUpperCase()}`;
        const redirectUrl = `${process.env.APP_URL}/payment/callback?ref=${reference}`;

        dbRun(
            `INSERT INTO top_ups (id, user_id, order_id, amount, reference, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
            [nanoid(), user.id, body.data.orderId ?? null, body.data.amount, reference]
        );

        // In production, call Paystack API here. For now return a mock URL.
        const paymentUrl = process.env.PAYSTACK_SECRET_KEY?.startsWith('sk_live')
            ? `https://checkout.paystack.com/${reference}` // Real Paystack
            : `${process.env.APP_URL}/payment/mock?ref=${reference}&amount=${body.data.amount}`;

        return reply.send({ paymentUrl, reference });
    });
};

function formatOrder(o: any) {
    return {
        id: o.id,
        userId: o.user_id,
        mealId: o.meal_id,
        mealName: o.meal_name,
        date: o.date,
        status: o.status,
        totalAmount: o.total_amount,
        allowanceCovered: o.allowance_covered,
        employeePaid: o.employee_paid,
        companyId: o.company_id,
        deliveryAddress: o.delivery_address ?? undefined,
        notes: o.notes ?? undefined,
        cancellable: o.cancellable === 1,
        createdAt: o.created_at,
        updatedAt: o.updated_at,
    };
}

export default employeeRoutes;