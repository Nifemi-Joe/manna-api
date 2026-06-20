/**
 * src/routes/employee.ts
 * GET  /api/v1/menus
 * GET  /api/v1/employee/allowance
 * GET  /api/v1/orders/me
 * POST /api/v1/orders
 * PATCH /api/v1/orders/:id/cancel
 * POST /api/v1/payments/paystack/initialize
 */
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';
function toDateStr(value) {
    if (value instanceof Date)
        return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}
const placeOrderSchema = z.object({
    mealId: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().optional(),
});
const topUpSchema = z.object({
    amount: z.number().positive(),
    orderId: z.string().optional(),
});
/**
 * Helper: meals.allergens / meals.dietary are JSONB columns.
 * node-postgres auto-parses JSONB into JS values, so these may already be
 * arrays — but stay defensive in case a row was inserted as a raw string.
 */
function asArray(value) {
    if (Array.isArray(value))
        return value;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        }
        catch {
            return [];
        }
    }
    return [];
}
const employeeRoutes = async (fastify) => {
    // GET /api/v1/menus — current week's published menu
    fastify.get('/menus', async (req, reply) => {
        await req.requireAuth();
        // Find the published menu for the current or upcoming week
        const menu = await dbGet(`SELECT id, week_start FROM menus WHERE published = TRUE
       ORDER BY week_start DESC LIMIT 1`);
        if (!menu) {
            return reply.status(404).send({ message: 'No menu published yet' });
        }
        const days = await dbAll(`SELECT date, cutoff_time, meal_id
       FROM menu_meals WHERE menu_id = $1
       ORDER BY date, meal_id`, [menu.id]);
        // Group by date
        const dateMap = new Map();
        for (const row of days) {
            const dateKey = toDateStr(row.date);
            if (!dateMap.has(dateKey)) {
                dateMap.set(dateKey, { date: dateKey, cutoffTime: row.cutoff_time, meals: [] });
            }
            const meal = await dbGet('SELECT * FROM meals WHERE id = $1 AND available = TRUE', [row.meal_id]);
            if (meal) {
                dateMap.get(dateKey).meals.push({
                    id: meal.id,
                    name: meal.name,
                    description: meal.description,
                    price: meal.price,
                    spiceLevel: meal.spice_level,
                    allergens: asArray(meal.allergens),
                    dietary: asArray(meal.dietary),
                    imageUrl: meal.image_url ?? undefined,
                    available: meal.available === true,
                });
            }
        }
        return {
            week: toDateStr(menu.week_start),
            days: Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
        };
    });
    // GET /api/v1/employee/allowance
    fastify.get('/employee/allowance', async (req) => {
        const user = await req.requireAuth();
        if (!user.companyId)
            return { dailyAmount: 0, remaining: 0, used: 0, resetAt: '', mealType: 'lunch' };
        const rules = await dbGet('SELECT * FROM allowance_rules WHERE company_id = $1', [user.companyId]);
        const today = new Date().toISOString().slice(0, 10);
        const resetAt = `${today}T23:59:59.999Z`;
        // Get or create today's ledger entry
        let ledger = await dbGet('SELECT amount, used FROM allowance_ledger WHERE user_id = $1 AND date = $2', [user.id, today]);
        if (!ledger) {
            const amount = rules?.daily_amount ?? 2500;
            await dbRun(`INSERT INTO allowance_ledger (id, user_id, date, amount, used, reset_at)
         VALUES ($1, $2, $3, $4, 0, $5)
         ON CONFLICT (user_id, date) DO NOTHING`, [nanoid(), user.id, today, amount, resetAt]);
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
        const orders = await dbAll(`SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [user.id]);
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
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid order data', errors: body.error.flatten() });
        const { mealId, date, notes } = body.data;
        if (!user.companyId)
            return reply.status(403).send({ message: 'No company associated with account' });
        // Validate meal exists and is in the menu for that date
        const meal = await dbGet('SELECT * FROM meals WHERE id = $1 AND available = TRUE', [mealId]);
        if (!meal)
            return reply.status(404).send({ message: 'Meal not found or unavailable' });
        // Check cutoff hasn't passed
        const menuMeal = await dbGet(`SELECT mm.cutoff_time FROM menu_meals mm
       JOIN menus m ON m.id = mm.menu_id
       WHERE mm.meal_id = $1 AND mm.date = $2 AND m.published = TRUE`, [mealId, date]);
        if (!menuMeal)
            return reply.status(400).send({ message: 'Meal not available on this date' });
        if (new Date() > new Date(menuMeal.cutoff_time)) {
            return reply.status(400).send({ message: 'Order cutoff has passed for this date' });
        }
        // Check duplicate order
        const existing = await dbGet('SELECT id FROM orders WHERE user_id = $1 AND date = $2 AND status != $3', [user.id, date, 'cancelled']);
        if (existing)
            return reply.status(409).send({ message: 'You already have an order for this date' });
        // Get allowance
        const rules = await dbGet('SELECT * FROM allowance_rules WHERE company_id = $1', [user.companyId]);
        const dailyAllowance = rules?.daily_amount ?? 0;
        const today = new Date().toISOString().slice(0, 10);
        let ledger = await dbGet('SELECT amount, used FROM allowance_ledger WHERE user_id = $1 AND date = $2', [user.id, today]);
        if (!ledger) {
            const resetAt = `${today}T23:59:59.999Z`;
            await dbRun(`INSERT INTO allowance_ledger (id, user_id, date, amount, used, reset_at)
         VALUES ($1, $2, $3, $4, 0, $5)
         ON CONFLICT (user_id, date) DO NOTHING`, [nanoid(), user.id, today, dailyAllowance, resetAt]);
            ledger = { amount: dailyAllowance, used: 0 };
        }
        const remaining = Math.max(0, ledger.amount - ledger.used);
        const allowanceCovered = Math.min(meal.price, remaining);
        const employeePaid = meal.price - allowanceCovered;
        const orderId = nanoid();
        const company = await dbGet('SELECT address FROM companies WHERE id = $1', [user.companyId]);
        try {
            await dbRun(`INSERT INTO orders (id, user_id, company_id, meal_id, meal_name, date, status, total_amount, allowance_covered, employee_paid, delivery_address, notes, cancellable)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, TRUE)`, [orderId, user.id, user.companyId, mealId, meal.name, date, meal.price, allowanceCovered, employeePaid, company?.address ?? '', notes ?? null]);
        }
        catch (err) {
            // Postgres unique_violation on (user_id, date)
            if (err?.code === '23505') {
                return reply.status(409).send({ message: 'You already have an order for this date' });
            }
            throw err;
        }
        // Create delivery record
        await dbRun(`INSERT INTO deliveries (id, order_id, company_id, status, delivery_address, scheduled_for)
       VALUES ($1, $2, $3, 'scheduled', $4, $5)`, [nanoid(), orderId, user.companyId, company?.address ?? '', `${date}T12:30:00.000Z`]);
        // Deduct from allowance ledger
        await dbRun('UPDATE allowance_ledger SET used = used + $1 WHERE user_id = $2 AND date = $3', [allowanceCovered, user.id, today]);
        const order = await dbGet('SELECT * FROM orders WHERE id = $1', [orderId]);
        const requiresTopUp = employeePaid > 0;
        const response = {
            order: formatOrder(order),
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
        const { id } = req.params;
        const order = await dbGet('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, user.id]);
        if (!order)
            return reply.status(404).send({ message: 'Order not found' });
        if (!order.cancellable)
            return reply.status(400).send({ message: 'Order cannot be cancelled' });
        if (['cancelled', 'delivered'].includes(order.status)) {
            return reply.status(400).send({ message: `Order is already ${order.status}` });
        }
        await dbRun(`UPDATE orders SET status = 'cancelled', cancellable = FALSE, updated_at = now() WHERE id = $1`, [id]);
        // Refund allowance
        const today = new Date().toISOString().slice(0, 10);
        await dbRun('UPDATE allowance_ledger SET used = GREATEST(0, used - $1) WHERE user_id = $2 AND date = $3', [order.allowance_covered, user.id, today]);
        return { success: true };
    });
    // POST /api/v1/payments/paystack/initialize
    fastify.post('/payments/paystack/initialize', async (req, reply) => {
        const user = await req.requireAuth();
        const body = topUpSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid top-up data' });
        const reference = `MANNA-${nanoid(12).toUpperCase()}`;
        await dbRun(`INSERT INTO top_ups (id, user_id, order_id, amount, reference, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`, [nanoid(), user.id, body.data.orderId ?? null, body.data.amount, reference]);
        // In production, call Paystack API here. For now return a mock URL.
        const paymentUrl = process.env.PAYSTACK_SECRET_KEY?.startsWith('sk_live')
            ? `https://checkout.paystack.com/${reference}` // Real Paystack
            : `${process.env.APP_URL}/payment/mock?ref=${reference}&amount=${body.data.amount}`;
        return reply.send({ paymentUrl, reference });
    });
};
function formatOrder(o) {
    return {
        id: o.id,
        userId: o.user_id,
        mealId: o.meal_id,
        mealName: o.meal_name,
        date: toDateStr(o.date),
        status: o.status,
        totalAmount: o.total_amount,
        allowanceCovered: o.allowance_covered,
        employeePaid: o.employee_paid,
        companyId: o.company_id,
        deliveryAddress: o.delivery_address ?? undefined,
        notes: o.notes ?? undefined,
        cancellable: o.cancellable === true,
        createdAt: o.created_at,
        updatedAt: o.updated_at,
    };
}
export default employeeRoutes;
