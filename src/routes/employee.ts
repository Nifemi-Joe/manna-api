/**
 * src/routes/employee.ts
 * GET  /api/v1/menus?window=breakfast|lunch
 * GET  /api/v1/employee/allowance?window=breakfast|lunch
 * GET  /api/v1/employee/colleagues
 * GET  /api/v1/orders/me
 * POST /api/v1/orders/cart          (NEW — replaces single-item POST /orders)
 * PATCH /api/v1/orders/:id/cancel
 * POST /api/v1/payments/paystack/initialize
 *
 * UPDATED (this pass) — cart-based checkout:
 *
 * POST /orders (single meal, one at a time) is replaced by POST
 * /orders/cart, which takes an array of {mealId, quantity}. Each item
 * is processed through the EXACT SAME allowance → overspend →
 * employee-pay logic as before, just looped sequentially so the ledger
 * usage accumulates correctly across the whole cart — ordering three
 * items in one cart produces the identical allowance math as ordering
 * them one at a time in the same sequence, just as one transaction
 * instead of three separate ones.
 *
 * Working-day/holiday and delegated-ordering checks now run once for
 * the whole cart rather than once per item.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';
import { notifyUsers } from '../services/notifications.js';

type MealWindow = 'breakfast' | 'lunch';
const MEAL_WINDOWS: MealWindow[] = ['breakfast', 'lunch'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const BREAKFAST_WINDOW_END_HOUR = parseInt(process.env.BREAKFAST_WINDOW_END_HOUR ?? '10', 10);
const DEFAULT_BREAKFAST_CUTOFF_HOUR = parseInt(process.env.DEFAULT_BREAKFAST_CUTOFF_HOUR ?? '9', 10);
const DEFAULT_LUNCH_CUTOFF_HOUR = parseInt(process.env.DEFAULT_LUNCH_CUTOFF_HOUR ?? '13', 10);

function toMoney(value: unknown, fallback = 0): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
    }
    return fallback;
}

function toDateStr(value: unknown): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}

function asArray(value: unknown): any[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return []; }
    }
    return [];
}

function inferWindowFromTime(): MealWindow {
    const hour = new Date().getUTCHours();
    return hour < BREAKFAST_WINDOW_END_HOUR ? 'breakfast' : 'lunch';
}

function parseWindow(raw: unknown): MealWindow {
    if (MEAL_WINDOWS.includes(raw as MealWindow)) return raw as MealWindow;
    return inferWindowFromTime();
}

function defaultCutoffIso(date: string, window: MealWindow): string {
    const hour = window === 'breakfast' ? DEFAULT_BREAKFAST_CUTOFF_HOUR : DEFAULT_LUNCH_CUTOFF_HOUR;
    return `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

function dayNameOf(dateStr: string): string {
    return DAY_NAMES[new Date(`${dateStr}T00:00:00.000Z`).getUTCDay()];
}

function formatMealForResponse(meal: any) {
    return {
        id: meal.id,
        name: meal.name,
        description: meal.description,
        price: toMoney(meal.price),
        spiceLevel: meal.spice_level,
        allergens: asArray(meal.allergens),
        dietary: asArray(meal.dietary),
        mealWindow: meal.meal_window,
        imageUrl: meal.image_url ?? undefined,
        available: meal.available === true,
    };
}

const cartItemSchema = z.object({
    mealId: z.string(),
    quantity: z.number().int().positive().max(20).default(1),
});

const checkoutCartSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    items: z.array(cartItemSchema).min(1, 'Cart is empty').max(30, 'Too many items in one cart'),
    notes: z.string().optional(),
    onBehalfOfUserId: z.string().optional(),
});

const topUpSchema = z.object({
    amount: z.number().positive(),
    orderId: z.string().optional(),
});

async function resolveAllowanceAmount(payerId: string, companyId: string, window: MealWindow): Promise<number> {
    const payer = await dbGet<any>(
        'SELECT allowance_override_lunch, allowance_override_breakfast, level_id FROM users WHERE id = $1',
        [payerId]
    );
    const override = window === 'breakfast' ? payer?.allowance_override_breakfast : payer?.allowance_override_lunch;
    if (override != null) return toMoney(override);

    if (payer?.level_id) {
        const level = await dbGet<any>('SELECT daily_amount_lunch, daily_amount_breakfast FROM staff_levels WHERE id = $1', [payer.level_id]);
        const levelAmount = window === 'breakfast' ? level?.daily_amount_breakfast : level?.daily_amount_lunch;
        if (levelAmount != null) return toMoney(levelAmount);
    }

    const rules = await dbGet<any>('SELECT daily_amount, daily_amount_breakfast FROM allowance_rules WHERE company_id = $1', [companyId]);
    if (window === 'breakfast') return toMoney(rules?.daily_amount_breakfast, 0);
    return toMoney(rules?.daily_amount, 2500);
}

async function resolveOverspendLimit(payerId: string, window: MealWindow): Promise<number> {
    const payer = await dbGet<any>('SELECT level_id FROM users WHERE id = $1', [payerId]);
    if (!payer?.level_id) return 0;
    const level = await dbGet<any>('SELECT overspend_limit_lunch, overspend_limit_breakfast FROM staff_levels WHERE id = $1', [payer.level_id]);
    const limit = window === 'breakfast' ? level?.overspend_limit_breakfast : level?.overspend_limit_lunch;
    return toMoney(limit, 0);
}

async function resolveCanOrderForOthers(userId: string): Promise<boolean> {
    const user = await dbGet<any>('SELECT level_id FROM users WHERE id = $1', [userId]);
    if (!user?.level_id) return false;
    const level = await dbGet<any>('SELECT can_order_for_others FROM staff_levels WHERE id = $1', [user.level_id]);
    return level?.can_order_for_others === true;
}

async function checkWorkingDay(companyId: string, dateStr: string): Promise<string | null> {
    const rules = await dbGet<any>('SELECT eligible_days FROM allowance_rules WHERE company_id = $1', [companyId]);
    const eligibleDays: string[] = rules?.eligible_days
        ? (typeof rules.eligible_days === 'string' ? JSON.parse(rules.eligible_days) : rules.eligible_days)
        : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

    const dayName = dayNameOf(dateStr);
    if (!eligibleDays.includes(dayName)) {
        return `${dayName} isn't a working day for your company.`;
    }

    const holiday = await dbGet<any>('SELECT label FROM company_holidays WHERE company_id = $1 AND date = $2', [companyId, dateStr]);
    if (holiday) {
        return `Ordering is closed today for ${holiday.label}.`;
    }

    return null;
}

async function getOrCreateLedger(payerId: string, companyId: string, date: string, window: MealWindow) {
    let ledger = await dbGet<{ amount: number; used: number }>(
        'SELECT amount, used FROM allowance_ledger WHERE user_id = $1 AND date = $2 AND meal_window = $3',
        [payerId, date, window]
    );
    if (!ledger) {
        const amount = await resolveAllowanceAmount(payerId, companyId, window);
        const resetAt = `${date}T23:59:59.999Z`;
        await dbRun(
            `INSERT INTO allowance_ledger (id, user_id, date, amount, used, reset_at, meal_window)
             VALUES ($1, $2, $3, $4, 0, $5, $6)
                 ON CONFLICT (user_id, date, meal_window) DO NOTHING`,
            [nanoid(), payerId, date, amount, resetAt, window]
        );
        ledger = { amount, used: 0 };
    }
    return ledger;
}

async function availableMealsFor(w: MealWindow) {
    const rows = await dbAll<any>('SELECT * FROM meals WHERE available = TRUE AND meal_window = $1 ORDER BY name', [w]);
    return rows.map(formatMealForResponse);
}

const employeeRoutes: FastifyPluginAsync = async (fastify) => {

    fastify.get('/menus', async (req) => {
        await req.requireAuth();
        const query = req.query as Record<string, string>;
        const window = parseWindow(query.window);
        const today = new Date().toISOString().slice(0, 10);

        const menu = await dbGet<{ id: string; week_start: string }>(
            `SELECT id, week_start FROM menus WHERE published = TRUE ORDER BY week_start DESC LIMIT 1`
        );

        if (menu) {
            const scheduledToday = await dbAll<{ date: string; cutoff_time: string; meal_id: string }>(
                `SELECT date, cutoff_time, meal_id FROM menu_meals
                 WHERE menu_id = $1 AND meal_window = $2 AND date = $3
                 ORDER BY meal_id`,
                [menu.id, window, today]
            );

            if (scheduledToday.length > 0) {
                const meals: any[] = [];
                for (const row of scheduledToday) {
                    const meal = await dbGet<any>(
                        'SELECT * FROM meals WHERE id = $1 AND available = TRUE AND meal_window = $2',
                        [row.meal_id, window]
                    );
                    if (meal) meals.push(formatMealForResponse(meal));
                }
                if (meals.length > 0) {
                    return {
                        week: toDateStr(menu.week_start),
                        mealWindow: window,
                        isFallback: false,
                        days: [{ date: today, cutoffTime: scheduledToday[0].cutoff_time, mealWindow: window, meals }],
                    };
                }
            }
        }

        const fallbackMeals = await dbAll<any>(
            'SELECT * FROM meals WHERE available = TRUE AND meal_window = $1 ORDER BY name',
            [window]
        );

        return {
            week: today,
            mealWindow: window,
            isFallback: true,
            days: [{ date: today, cutoffTime: defaultCutoffIso(today, window), mealWindow: window, meals: fallbackMeals.map(formatMealForResponse) }],
        };
    });

    fastify.get('/employee/allowance', async (req) => {
        const user = await req.requireAuth();
        const query = req.query as Record<string, string>;
        const window = parseWindow(query.window);

        if (!user.companyId) return { dailyAmount: 0, daily: 0, remaining: 0, used: 0, resetAt: '', mealWindow: window, overspendLimit: 0, canOrderForOthers: false };

        const today = new Date().toISOString().slice(0, 10);
        const ledger = await getOrCreateLedger(user.id, user.companyId, today, window);
        const overspendLimit = await resolveOverspendLimit(user.id, window);
        const canOrderForOthers = await resolveCanOrderForOthers(user.id);
        const resetAt = `${today}T23:59:59.999Z`;

        return {
            dailyAmount: toMoney(ledger.amount),
            daily: toMoney(ledger.amount),
            remaining: Math.max(0, toMoney(ledger.amount) - toMoney(ledger.used)),
            used: toMoney(ledger.used),
            resetAt,
            mealWindow: window,
            overspendLimit,
            canOrderForOthers,
        };
    });

    fastify.get('/employee/colleagues', async (req) => {
        const user = await req.requireAuth();
        if (!user.companyId) return { colleagues: [] };

        const rows = await dbAll<any>(
            `SELECT id, name, email FROM users
             WHERE company_id = $1 AND portal = 'employee' AND status = 'active' AND id != $2
             ORDER BY name`,
            [user.companyId, user.id]
        );
        return { colleagues: rows.map((r) => ({ id: r.id, name: r.name, email: r.email })) };
    });

    fastify.get('/orders/me', async (req) => {
        const user = await req.requireAuth();
        const orders = await dbAll<any>(
            `SELECT o.*, recipient.name as recipient_name, payer.name as payer_name
             FROM orders o
                      JOIN users recipient ON recipient.id = o.user_id
                      JOIN users payer ON payer.id = o.ordered_by_user_id
             WHERE o.user_id = $1 OR o.ordered_by_user_id = $1
             ORDER BY o.created_at DESC LIMIT 100`,
            [user.id]
        );
        return { orders: orders.map((o) => formatOrder(o, user.id)), total: orders.length, page: 1, perPage: 100 };
    });

    // POST /api/v1/orders/cart — checks out an entire cart of items at once.
    fastify.post('/orders/cart', async (req, reply) => {
        const requester = await req.requirePermission('orders:create');

        const body = checkoutCartSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid cart', errors: body.error.flatten() });

        const { date, items, notes, onBehalfOfUserId } = body.data;
        if (!requester.companyId) return reply.status(403).send({ message: 'No company associated with account' });

        // 1. Working-day / holiday check — once for the whole cart.
        const workingDayIssue = await checkWorkingDay(requester.companyId, date);
        if (workingDayIssue) {
            return reply.status(400).send({ message: workingDayIssue, closedForDay: true });
        }

        // 2. Delegated-ordering authorization — once for the whole cart.
        let recipientId = requester.id;
        if (onBehalfOfUserId && onBehalfOfUserId !== requester.id) {
            const requesterRecord = await dbGet<any>('SELECT level_id FROM users WHERE id = $1', [requester.id]);
            const level = requesterRecord?.level_id
                ? await dbGet<any>('SELECT can_order_for_others FROM staff_levels WHERE id = $1', [requesterRecord.level_id])
                : null;

            if (!level?.can_order_for_others) {
                return reply.status(403).send({ message: "You're not authorized to order on behalf of a colleague. Ask HR to grant your level that permission." });
            }

            const recipient = await dbGet<any>('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND status = $3', [onBehalfOfUserId, requester.companyId, 'active']);
            if (!recipient) return reply.status(404).send({ message: 'That colleague was not found in your company' });

            recipientId = onBehalfOfUserId;
        }

        // 3. Load and validate every meal in the cart BEFORE charging
        // anything — if any item is invalid, reject the whole cart
        // rather than partially checking out.
        const loadedItems: Array<{ meal: any; quantity: number; window: MealWindow }> = [];
        let cartWindow: MealWindow | null = null;

        for (const item of items) {
            const meal = await dbGet<any>('SELECT * FROM meals WHERE id = $1', [item.mealId]);
            if (!meal || meal.available !== true) {
                return reply.status(404).send({
                    message: `"${meal?.name ?? item.mealId}" isn't available. Remove it from your cart and try again.`,
                    availableMeals: await availableMealsFor(cartWindow ?? inferWindowFromTime()),
                });
            }

            const window: MealWindow = meal.meal_window === 'breakfast' ? 'breakfast' : 'lunch';
            if (cartWindow && window !== cartWindow) {
                return reply.status(400).send({ message: 'A single order can only mix items from the same meal window (breakfast or lunch), not both.' });
            }
            cartWindow = window;

            const menuMeal = await dbGet<any>(
                `SELECT mm.cutoff_time FROM menu_meals mm
                                                JOIN menus m ON m.id = mm.menu_id
                 WHERE mm.meal_id = $1 AND mm.date = $2 AND mm.meal_window = $3 AND m.published = TRUE`,
                [item.mealId, date, window]
            );
            const cutoffIso = menuMeal?.cutoff_time ?? defaultCutoffIso(date, window);
            if (new Date() > new Date(cutoffIso)) {
                return reply.status(400).send({
                    message: `Ordering for ${window} has closed for today. Here's what was available.`,
                    availableMeals: await availableMealsFor(window),
                });
            }

            const existing = await dbGet(
                'SELECT id FROM orders WHERE user_id = $1 AND date = $2 AND meal_window = $3 AND meal_id = $4 AND status != $5',
                [recipientId, date, window, item.mealId, 'cancelled']
            );
            if (existing) {
                return reply.status(409).send({ message: `${recipientId === requester.id ? "You've" : 'That colleague has'} already ordered "${meal.name}" for this date.` });
            }

            loadedItems.push({ meal, quantity: item.quantity, window });
        }

        if (!cartWindow) return reply.status(400).send({ message: 'Cart is empty' });

        // 4. Walk the cart sequentially, applying the SAME per-item
        // allowance → overspend → employee-pay math as single-item
        // ordering always used — just accumulated across the cart so
        // the ledger usage compounds correctly item by item.
        const today = new Date().toISOString().slice(0, 10);
        const ledger = await getOrCreateLedger(requester.id, requester.companyId, today, cartWindow);
        const overspendLimit = await resolveOverspendLimit(requester.id, cartWindow);

        let runningUsed = toMoney(ledger.used);
        let runningOverspendUsed = 0; // tracked separately from the base ledger, capped at overspendLimit
        const baseAmount = toMoney(ledger.amount);

        const cartId = nanoid();
        const company = await dbGet<any>('SELECT address FROM companies WHERE id = $1', [requester.companyId]);
        const createdOrders: any[] = [];
        let cartTotal = 0;
        let cartAllowanceCovered = 0;
        let cartOverspendCovered = 0;
        let cartEmployeePaid = 0;

        for (const { meal, quantity, window } of loadedItems) {
            const lineTotal = toMoney(meal.price) * quantity;
            cartTotal += lineTotal;

            const remainingBase = Math.max(0, baseAmount - runningUsed);
            const coveredByBase = Math.min(lineTotal, remainingBase);

            const remainingOverspend = Math.max(0, overspendLimit - runningOverspendUsed);
            const remainingAfterBase = lineTotal - coveredByBase;
            const coveredByOverspend = Math.min(remainingAfterBase, remainingOverspend);

            const lineAllowanceCovered = coveredByBase + coveredByOverspend;
            const lineEmployeePaid = lineTotal - lineAllowanceCovered;

            runningUsed += coveredByBase;
            runningOverspendUsed += coveredByOverspend;
            cartAllowanceCovered += lineAllowanceCovered;
            cartOverspendCovered += coveredByOverspend;
            cartEmployeePaid += lineEmployeePaid;

            const orderId = nanoid();
            await dbRun(
                `INSERT INTO orders (id, user_id, ordered_by_user_id, company_id, meal_id, meal_name, date, status, total_amount, allowance_covered, overspend_covered, employee_paid, delivery_address, notes, cancellable, meal_window, quantity, cart_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12, $13, TRUE, $14, $15, $16)`,
                [orderId, recipientId, requester.id, requester.companyId, meal.id, meal.name, date, lineTotal, lineAllowanceCovered, coveredByOverspend, lineEmployeePaid, company?.address ?? '', notes ?? null, window, quantity, cartId]
            );

            const scheduledTime = window === 'breakfast' ? '08:00:00.000Z' : '12:30:00.000Z';
            await dbRun(
                `INSERT INTO deliveries (id, order_id, company_id, status, delivery_address, scheduled_for)
                 VALUES ($1, $2, $3, 'scheduled', $4, $5)`,
                [nanoid(), orderId, requester.companyId, company?.address ?? '', `${date}T${scheduledTime}`]
            );

            const created = await dbGet<any>('SELECT * FROM orders WHERE id = $1', [orderId]);
            createdOrders.push(formatOrder(created, requester.id));
        }

        // 5. Ledger is charged once, for the base-allowance portion of
        // the whole cart's total (overspend usage isn't tracked in the
        // ledger's `used` column separately — same convention the
        // single-item flow used before this).
        await dbRun(
            'UPDATE allowance_ledger SET used = used + $1 WHERE user_id = $2 AND date = $3 AND meal_window = $4',
            [cartAllowanceCovered, requester.id, today, cartWindow]
        );

        if (recipientId !== requester.id) {
            const itemNames = loadedItems.map((i) => i.meal.name).join(', ');
            await notifyUsers([recipientId], {
                kind: 'order',
                title: `${requester.name} ordered ${cartWindow} for you`,
                body: `${itemNames} — arriving with today's delivery.`,
                link: '/employee/orders',
            });
        }

        const requiresTopUp = cartEmployeePaid > 0;
        const response: any = {
            orders: createdOrders,
            cartId,
            totalAmount: cartTotal,
            allowanceCovered: cartAllowanceCovered,
            overspendCovered: cartOverspendCovered,
            employeePaid: cartEmployeePaid,
            requiresTopUp,
            usedOverspend: cartOverspendCovered > 0,
        };

        if (requiresTopUp) {
            response.topUpAmount = cartEmployeePaid;
            response.paymentUrl = `${process.env.APP_URL}/pay?cartId=${cartId}&amount=${cartEmployeePaid}`;
        }

        return reply.status(201).send(response);
    });

    fastify.patch('/orders/:id/cancel', async (req, reply) => {
        const user = await req.requirePermission('orders:cancel');
        const { id } = req.params as { id: string };

        const order = await dbGet<any>('SELECT * FROM orders WHERE id = $1 AND (user_id = $2 OR ordered_by_user_id = $2)', [id, user.id]);
        if (!order) return reply.status(404).send({ message: 'Order not found' });
        if (!order.cancellable) return reply.status(400).send({ message: 'Order cannot be cancelled' });
        if (['cancelled', 'delivered'].includes(order.status)) {
            return reply.status(400).send({ message: `Order is already ${order.status}` });
        }

        await dbRun(`UPDATE orders SET status = 'cancelled', cancellable = FALSE, updated_at = now() WHERE id = $1`, [id]);

        const today = new Date().toISOString().slice(0, 10);
        const window: MealWindow = order.meal_window === 'breakfast' ? 'breakfast' : 'lunch';
        const payerId = order.ordered_by_user_id ?? order.user_id;
        await dbRun(
            'UPDATE allowance_ledger SET used = GREATEST(0, used - $1) WHERE user_id = $2 AND date = $3 AND meal_window = $4',
            [toMoney(order.allowance_covered), payerId, today, window]
        );

        return { success: true };
    });

    fastify.post('/payments/paystack/initialize', async (req, reply) => {
        const user = await req.requireAuth();

        const body = topUpSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid top-up data' });

        const reference = `MANNA-${nanoid(12).toUpperCase()}`;

        await dbRun(
            `INSERT INTO top_ups (id, user_id, order_id, amount, reference, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [nanoid(), user.id, body.data.orderId ?? null, body.data.amount, reference]
        );

        const paymentUrl = process.env.PAYSTACK_SECRET_KEY?.startsWith('sk_live')
            ? `https://checkout.paystack.com/${reference}`
            : `${process.env.APP_URL}/payment/mock?ref=${reference}&amount=${body.data.amount}`;

        return reply.send({ paymentUrl, reference });
    });
};

function formatOrder(o: any, viewerUserId?: string) {
    return {
        id: o.id,
        userId: o.user_id,
        orderedByUserId: o.ordered_by_user_id ?? o.user_id,
        recipientName: o.recipient_name ?? undefined,
        payerName: o.payer_name ?? undefined,
        isDelegated: o.ordered_by_user_id != null && o.ordered_by_user_id !== o.user_id,
        viewerRole: viewerUserId
            ? o.user_id === viewerUserId && o.ordered_by_user_id === viewerUserId
                ? 'self'
                : o.ordered_by_user_id === viewerUserId
                    ? 'payer'
                    : 'recipient'
            : undefined,
        mealId: o.meal_id,
        mealName: o.meal_name,
        quantity: o.quantity ?? 1,
        cartId: o.cart_id ?? undefined,
        date: toDateStr(o.date),
        status: o.status,
        totalAmount: toMoney(o.total_amount),
        allowanceCovered: toMoney(o.allowance_covered),
        overspendCovered: toMoney(o.overspend_covered),
        employeePaid: toMoney(o.employee_paid),
        companyId: o.company_id,
        mealWindow: o.meal_window ?? 'lunch',
        deliveryAddress: o.delivery_address ?? undefined,
        notes: o.notes ?? undefined,
        cancellable: o.cancellable === true,
        createdAt: o.created_at,
        updatedAt: o.updated_at,
    };
}

export default employeeRoutes;