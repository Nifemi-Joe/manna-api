/**
 * src/routes/ops.ts
 * GET   /api/v1/ops/deliveries
 * PATCH /api/v1/ops/deliveries/:id
 * GET   /api/v1/ops/issues
 * POST  /api/v1/ops/issues
 * PATCH /api/v1/ops/issues/:id
 * GET   /api/v1/ops/packing        (packing list grouped by company)
 * GET   /api/v1/ops/menus/:weekStart
 * PATCH /api/v1/ops/menus/:weekStart
 * POST  /api/v1/ops/menus/:weekStart/publish
 */
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';
function toDateStr(value) {
    if (value instanceof Date)
        return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}
const updateDeliverySchema = z.object({
    status: z.enum(['scheduled', 'packed', 'dispatched', 'delivered', 'failed']),
    notes: z.string().optional(),
});
const createIssueSchema = z.object({
    title: z.string().min(3),
    description: z.string().optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
    companyId: z.string().optional(),
    orderId: z.string().optional(),
});
const updateIssueSchema = z.object({
    status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    description: z.string().optional(),
});
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
const opsRoutes = async (fastify) => {
    // GET /api/v1/ops/deliveries
    fastify.get('/deliveries', async (req) => {
        await req.requirePermission('deliveries:read');
        const query = req.query;
        const conditions = [];
        const params = [];
        if (query.status) {
            params.push(query.status);
            conditions.push(`d.status = $${params.length}`);
        }
        if (query.company) {
            params.push(query.company);
            conditions.push(`d.company_id = $${params.length}`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = await dbAll(`SELECT d.*, o.meal_name, o.notes as order_notes,
              u.name as employee_name, u.email as employee_email,
              c.name as company_name,
              m.dietary
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       JOIN users u ON u.id = o.user_id
       JOIN companies c ON c.id = d.company_id
       JOIN meals m ON m.id = o.meal_id
       ${where}
       ORDER BY d.scheduled_for, c.name`, params);
        return {
            deliveries: rows.map(r => ({
                id: r.id,
                orderId: r.order_id,
                companyId: r.company_id,
                companyName: r.company_name,
                employeeName: r.employee_name,
                employeeEmail: r.employee_email,
                mealName: r.meal_name,
                status: r.status,
                deliveryAddress: r.delivery_address,
                scheduledFor: r.scheduled_for,
                updatedAt: r.updated_at,
                notes: r.notes ?? r.order_notes ?? undefined,
                dietary: asArray(r.dietary),
            })),
            total: rows.length,
        };
    });
    // PATCH /api/v1/ops/deliveries/:id
    fastify.patch('/deliveries/:id', async (req, reply) => {
        await req.requirePermission('deliveries:update');
        const { id } = req.params;
        const body = updateDeliverySchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid delivery update' });
        const delivery = await dbGet('SELECT * FROM deliveries WHERE id = $1', [id]);
        if (!delivery)
            return reply.status(404).send({ message: 'Delivery not found' });
        await dbRun(`UPDATE deliveries SET status = $1, notes = $2, updated_at = now() WHERE id = $3`, [body.data.status, body.data.notes ?? delivery.notes, id]);
        // Sync order status
        const orderStatusMap = {
            packed: 'packed',
            dispatched: 'dispatched',
            delivered: 'delivered',
            failed: 'failed',
        };
        if (orderStatusMap[body.data.status]) {
            await dbRun(`UPDATE orders SET status = $1, cancellable = FALSE, updated_at = now() WHERE id = $2`, [orderStatusMap[body.data.status], delivery.order_id]);
        }
        const updated = await dbGet(`SELECT d.*, c.name as company_name, u.name as employee_name, u.email as employee_email, o.meal_name, m.dietary
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       JOIN users u ON u.id = o.user_id
       JOIN companies c ON c.id = d.company_id
       JOIN meals m ON m.id = o.meal_id
       WHERE d.id = $1`, [id]);
        return {
            delivery: {
                id: updated.id,
                orderId: updated.order_id,
                companyId: updated.company_id,
                companyName: updated.company_name,
                employeeName: updated.employee_name,
                employeeEmail: updated.employee_email,
                mealName: updated.meal_name,
                status: updated.status,
                deliveryAddress: updated.delivery_address,
                scheduledFor: updated.scheduled_for,
                updatedAt: updated.updated_at,
                notes: updated.notes ?? undefined,
                dietary: asArray(updated.dietary),
            },
        };
    });
    // GET /api/v1/ops/issues
    fastify.get('/issues', async (req) => {
        await req.requirePermission('issues:read');
        const query = req.query;
        const conditions = [];
        const params = [];
        if (query.status) {
            params.push(query.status);
            conditions.push(`i.status = $${params.length}`);
        }
        if (query.severity) {
            params.push(query.severity);
            conditions.push(`i.severity = $${params.length}`);
        }
        if (query.company) {
            params.push(query.company);
            conditions.push(`i.company_id = $${params.length}`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const issues = await dbAll(`SELECT i.*, c.name as company_name FROM issues i
       LEFT JOIN companies c ON c.id = i.company_id
       ${where}
       ORDER BY i.created_at DESC`, params);
        return {
            issues: issues.map(i => ({
                id: i.id,
                companyId: i.company_id ?? undefined,
                companyName: i.company_name ?? undefined,
                orderId: i.order_id ?? undefined,
                title: i.title,
                description: i.description,
                severity: i.severity,
                status: i.status,
                createdAt: i.created_at,
                updatedAt: i.updated_at,
            })),
            total: issues.length,
        };
    });
    // POST /api/v1/ops/issues
    fastify.post('/issues', async (req, reply) => {
        const user = await req.requirePermission('issues:write');
        const body = createIssueSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid issue data', errors: body.error.flatten() });
        const id = nanoid();
        await dbRun(`INSERT INTO issues (id, company_id, order_id, reporter_id, title, description, severity, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`, [id, body.data.companyId ?? null, body.data.orderId ?? null, user.id,
            body.data.title, body.data.description ?? '', body.data.severity]);
        const issue = await dbGet('SELECT * FROM issues WHERE id = $1', [id]);
        return reply.status(201).send({ issue: formatIssue(issue) });
    });
    // PATCH /api/v1/ops/issues/:id
    fastify.patch('/issues/:id', async (req, reply) => {
        await req.requirePermission('issues:write');
        const { id } = req.params;
        const issue = await dbGet('SELECT id FROM issues WHERE id = $1', [id]);
        if (!issue)
            return reply.status(404).send({ message: 'Issue not found' });
        const body = updateIssueSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid data' });
        const updates = [];
        const params = [];
        if (body.data.status) {
            params.push(body.data.status);
            updates.push(`status = $${params.length}`);
        }
        if (body.data.severity) {
            params.push(body.data.severity);
            updates.push(`severity = $${params.length}`);
        }
        if (body.data.description) {
            params.push(body.data.description);
            updates.push(`description = $${params.length}`);
        }
        if (updates.length) {
            updates.push('updated_at = now()');
            params.push(id);
            await dbRun(`UPDATE issues SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
        }
        const updated = await dbGet('SELECT * FROM issues WHERE id = $1', [id]);
        return { issue: formatIssue(updated) };
    });
    // GET /api/v1/ops/packing — today's packing list grouped by company
    fastify.get('/packing', async (req) => {
        await req.requirePermission('deliveries:read');
        const today = new Date().toISOString().slice(0, 10);
        const rows = await dbAll(`SELECT o.meal_name, o.meal_id, u.name as employee_name, c.name as company_name, c.id as company_id,
              m.dietary, m.allergens
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN companies c ON c.id = o.company_id
       JOIN meals m ON m.id = o.meal_id
       WHERE o.date = $1 AND o.status NOT IN ('cancelled', 'failed')
       ORDER BY c.name, o.meal_name, u.name`, [today]);
        // Group by company, then meal
        const grouped = {};
        for (const r of rows) {
            if (!grouped[r.company_id]) {
                grouped[r.company_id] = { companyId: r.company_id, companyName: r.company_name, meals: {} };
            }
            if (!grouped[r.company_id].meals[r.meal_name]) {
                grouped[r.company_id].meals[r.meal_name] = {
                    mealId: r.meal_id, mealName: r.meal_name,
                    dietary: asArray(r.dietary),
                    allergens: asArray(r.allergens),
                    employees: [],
                };
            }
            grouped[r.company_id].meals[r.meal_name].employees.push(r.employee_name);
        }
        return {
            date: today,
            companies: Object.values(grouped).map(c => ({
                ...c,
                meals: Object.values(c.meals),
                total: Object.values(c.meals).reduce((s, m) => s + m.employees.length, 0),
            })),
            total: rows.length,
        };
    });
    // GET /api/v1/ops/menus/:weekStart
    fastify.get('/menus/:weekStart', async (req, reply) => {
        await req.requirePermission('menus:read');
        const { weekStart } = req.params;
        const menu = await dbGet('SELECT * FROM menus WHERE week_start = $1', [weekStart]);
        if (!menu)
            return reply.status(404).send({ message: 'Menu not found' });
        return buildMenuResponse(menu);
    });
    // PATCH /api/v1/ops/menus/:weekStart — add/remove meals from a day
    fastify.patch('/menus/:weekStart', async (req, reply) => {
        await req.requirePermission('menus:write');
        const { weekStart } = req.params;
        const body = z.object({
            date: z.string(),
            meals: z.array(z.string()), // meal IDs
            cutoffTime: z.string().optional(),
        }).safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid menu data' });
        let menu = await dbGet('SELECT * FROM menus WHERE week_start = $1', [weekStart]);
        const caller = await req.requireAuth();
        if (!menu) {
            const id = nanoid();
            await dbRun(`INSERT INTO menus (id, week_start, published, created_by) VALUES ($1, $2, FALSE, $3)`, [id, weekStart, caller.id]);
            menu = await dbGet('SELECT * FROM menus WHERE id = $1', [id]);
        }
        const { date, meals, cutoffTime } = body.data;
        const cutoff = cutoffTime ?? `${date}T10:00:00.000Z`;
        // Replace meals for this date
        await dbRun('DELETE FROM menu_meals WHERE menu_id = $1 AND date = $2', [menu.id, date]);
        for (const mealId of meals) {
            const meal = await dbGet('SELECT id FROM meals WHERE id = $1', [mealId]);
            if (meal) {
                await dbRun(`INSERT INTO menu_meals (id, menu_id, date, meal_id, cutoff_time)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (menu_id, date, meal_id) DO NOTHING`, [nanoid(), menu.id, date, mealId, cutoff]);
            }
        }
        await dbRun(`UPDATE menus SET updated_at = now() WHERE id = $1`, [menu.id]);
        const refreshed = await dbGet('SELECT * FROM menus WHERE id = $1', [menu.id]);
        return buildMenuResponse(refreshed);
    });
    // POST /api/v1/ops/menus/:weekStart/publish
    fastify.post('/menus/:weekStart/publish', async (req, reply) => {
        await req.requirePermission('menus:publish');
        const { weekStart } = req.params;
        const menu = await dbGet('SELECT * FROM menus WHERE week_start = $1', [weekStart]);
        if (!menu)
            return reply.status(404).send({ message: 'Menu not found' });
        await dbRun(`UPDATE menus SET published = TRUE, published_at = now(), updated_at = now() WHERE id = $1`, [menu.id]);
        const refreshed = await dbGet('SELECT * FROM menus WHERE id = $1', [menu.id]);
        return buildMenuResponse(refreshed);
    });
};
function formatIssue(i) {
    return {
        id: i.id, companyId: i.company_id ?? undefined, orderId: i.order_id ?? undefined,
        title: i.title, description: i.description, severity: i.severity, status: i.status,
        createdAt: i.created_at, updatedAt: i.updated_at,
    };
}
async function buildMenuResponse(menu) {
    const mealRows = await dbAll(`SELECT mm.date, mm.cutoff_time, m.* FROM menu_meals mm
     JOIN meals m ON m.id = mm.meal_id
     WHERE mm.menu_id = $1 ORDER BY mm.date, m.name`, [menu.id]);
    const dateMap = new Map();
    for (const r of mealRows) {
        const dateKey = toDateStr(r.date);
        if (!dateMap.has(dateKey))
            dateMap.set(dateKey, { date: dateKey, cutoffTime: r.cutoff_time, meals: [] });
        dateMap.get(dateKey).meals.push({
            id: r.id, name: r.name, description: r.description, price: r.price,
            spiceLevel: r.spice_level, allergens: asArray(r.allergens),
            dietary: asArray(r.dietary), imageUrl: r.image_url ?? undefined,
            available: r.available === true,
        });
    }
    return {
        id: menu.id, weekStart: toDateStr(menu.week_start),
        published: menu.published === true, publishedAt: menu.published_at ?? undefined,
        days: Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    };
}
export default opsRoutes;
