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

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';

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

const opsRoutes: FastifyPluginAsync = async (fastify) => {

    // GET /api/v1/ops/deliveries
    fastify.get('/deliveries', async (req) => {
        await req.requirePermission('deliveries:read');

        const query = req.query as Record<string, string>;
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (query.status)  { conditions.push('d.status = ?');     params.push(query.status); }
        if (query.company) { conditions.push('d.company_id = ?'); params.push(query.company); }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const rows = dbAll<any>(
            `SELECT d.*, o.meal_name, o.notes as order_notes,
              u.name as employee_name, u.email as employee_email,
              c.name as company_name,
              m.dietary
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       JOIN users u ON u.id = o.user_id
       JOIN companies c ON c.id = d.company_id
       JOIN meals m ON m.id = o.meal_id
       ${where}
       ORDER BY d.scheduled_for, c.name`,
            params
        );

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
                dietary: JSON.parse(r.dietary ?? '[]'),
            })),
            total: rows.length,
        };
    });

    // PATCH /api/v1/ops/deliveries/:id
    fastify.patch('/deliveries/:id', async (req, reply) => {
        await req.requirePermission('deliveries:update');
        const { id } = req.params as { id: string };

        const body = updateDeliverySchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid delivery update' });

        const delivery = dbGet<any>('SELECT * FROM deliveries WHERE id = ?', [id]);
        if (!delivery) return reply.status(404).send({ message: 'Delivery not found' });

        dbRun(
            `UPDATE deliveries SET status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
            [body.data.status, body.data.notes ?? delivery.notes, id]
        );

        // Sync order status
        const orderStatusMap: Record<string, string> = {
            packed: 'packed',
            dispatched: 'dispatched',
            delivered: 'delivered',
            failed: 'failed',
        };
        if (orderStatusMap[body.data.status]) {
            dbRun(
                `UPDATE orders SET status = ?, cancellable = 0, updated_at = datetime('now') WHERE id = ?`,
                [orderStatusMap[body.data.status], delivery.order_id]
            );
        }

        const updated = dbGet<any>('SELECT d.*, c.name as company_name, u.name as employee_name, u.email as employee_email, o.meal_name, m.dietary FROM deliveries d JOIN orders o ON o.id = d.order_id JOIN users u ON u.id = o.user_id JOIN companies c ON c.id = d.company_id JOIN meals m ON m.id = o.meal_id WHERE d.id = ?', [id]);

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
                dietary: JSON.parse(updated.dietary ?? '[]'),
            },
        };
    });

    // GET /api/v1/ops/issues
    fastify.get('/issues', async (req) => {
        await req.requirePermission('issues:read');

        const query = req.query as Record<string, string>;
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (query.status)   { conditions.push('i.status = ?');    params.push(query.status); }
        if (query.severity) { conditions.push('i.severity = ?');  params.push(query.severity); }
        if (query.company)  { conditions.push('i.company_id = ?');params.push(query.company); }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const issues = dbAll<any>(
            `SELECT i.*, c.name as company_name FROM issues i
       LEFT JOIN companies c ON c.id = i.company_id
       ${where}
       ORDER BY i.created_at DESC`,
            params
        );

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
        if (!body.success) return reply.status(400).send({ message: 'Invalid issue data', errors: body.error.flatten() });

        const id = nanoid();
        dbRun(
            `INSERT INTO issues (id, company_id, order_id, reporter_id, title, description, severity, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
            [id, body.data.companyId ?? null, body.data.orderId ?? null, user.id,
                body.data.title, body.data.description ?? '', body.data.severity]
        );

        const issue = dbGet<any>('SELECT * FROM issues WHERE id = ?', [id]);
        return reply.status(201).send({ issue: formatIssue(issue) });
    });

    // PATCH /api/v1/ops/issues/:id
    fastify.patch('/issues/:id', async (req, reply) => {
        await req.requirePermission('issues:write');
        const { id } = req.params as { id: string };

        const issue = dbGet('SELECT id FROM issues WHERE id = ?', [id]);
        if (!issue) return reply.status(404).send({ message: 'Issue not found' });

        const body = updateIssueSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid data' });

        const updates: string[] = [];
        const params: unknown[] = [];
        if (body.data.status)      { updates.push('status = ?');      params.push(body.data.status); }
        if (body.data.severity)    { updates.push('severity = ?');    params.push(body.data.severity); }
        if (body.data.description) { updates.push('description = ?'); params.push(body.data.description); }
        if (updates.length) {
            updates.push('updated_at = datetime(\'now\')');
            params.push(id);
            dbRun(`UPDATE issues SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        const updated = dbGet<any>('SELECT * FROM issues WHERE id = ?', [id]);
        return { issue: formatIssue(updated) };
    });

    // GET /api/v1/ops/packing — today's packing list grouped by company
    fastify.get('/packing', async (req) => {
        await req.requirePermission('deliveries:read');

        const today = new Date().toISOString().slice(0, 10);
        const rows = dbAll<any>(
            `SELECT o.meal_name, o.meal_id, u.name as employee_name, c.name as company_name, c.id as company_id,
              m.dietary, m.allergens
       FROM orders o
       JOIN users u ON u.id = o.user_id
       JOIN companies c ON c.id = o.company_id
       JOIN meals m ON m.id = o.meal_id
       WHERE o.date = ? AND o.status NOT IN ('cancelled', 'failed')
       ORDER BY c.name, o.meal_name, u.name`,
            [today]
        );

        // Group by company, then meal
        const grouped: Record<string, any> = {};
        for (const r of rows) {
            if (!grouped[r.company_id]) {
                grouped[r.company_id] = { companyId: r.company_id, companyName: r.company_name, meals: {} };
            }
            if (!grouped[r.company_id].meals[r.meal_name]) {
                grouped[r.company_id].meals[r.meal_name] = {
                    mealId: r.meal_id, mealName: r.meal_name,
                    dietary: JSON.parse(r.dietary ?? '[]'),
                    allergens: JSON.parse(r.allergens ?? '[]'),
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
                total: Object.values<any>(c.meals).reduce((s, m) => s + m.employees.length, 0),
            })),
            total: rows.length,
        };
    });

    // GET /api/v1/ops/menus/:weekStart
    fastify.get('/menus/:weekStart', async (req, reply) => {
        await req.requirePermission('menus:read');
        const { weekStart } = req.params as { weekStart: string };

        const menu = dbGet<any>('SELECT * FROM menus WHERE week_start = ?', [weekStart]);
        if (!menu) return reply.status(404).send({ message: 'Menu not found' });

        return buildMenuResponse(menu);
    });

    // PATCH /api/v1/ops/menus/:weekStart — add/remove meals from a day
    fastify.patch('/menus/:weekStart', async (req, reply) => {
        await req.requirePermission('menus:write');
        const { weekStart } = req.params as { weekStart: string };

        const body = z.object({
            date: z.string(),
            meals: z.array(z.string()), // meal IDs
            cutoffTime: z.string().optional(),
        }).safeParse(req.body);

        if (!body.success) return reply.status(400).send({ message: 'Invalid menu data' });

        let menu = dbGet<any>('SELECT * FROM menus WHERE week_start = ?', [weekStart]);
        const caller = await req.requireAuth();
        if (!menu) {
            const id = nanoid();
            dbRun(
                `INSERT INTO menus (id, week_start, published, created_by) VALUES (?, ?, 0, ?)`,
                [id, weekStart, caller.id]
            );
            menu = dbGet<any>('SELECT * FROM menus WHERE id = ?', [id]);
        }

        const { date, meals, cutoffTime } = body.data;
        const cutoff = cutoffTime ?? `${date}T10:00:00.000Z`;

        // Replace meals for this date
        dbRun('DELETE FROM menu_meals WHERE menu_id = ? AND date = ?', [menu.id, date]);
        for (const mealId of meals) {
            const meal = dbGet('SELECT id FROM meals WHERE id = ?', [mealId]);
            if (meal) {
                dbRun(
                    `INSERT OR IGNORE INTO menu_meals (id, menu_id, date, meal_id, cutoff_time)
           VALUES (?, ?, ?, ?, ?)`,
                    [nanoid(), menu.id, date, mealId, cutoff]
                );
            }
        }

        dbRun(`UPDATE menus SET updated_at = datetime('now') WHERE id = ?`, [menu.id]);
        return buildMenuResponse(dbGet<any>('SELECT * FROM menus WHERE id = ?', [menu.id])!);
    });

    // POST /api/v1/ops/menus/:weekStart/publish
    fastify.post('/menus/:weekStart/publish', async (req, reply) => {
        await req.requirePermission('menus:publish');
        const { weekStart } = req.params as { weekStart: string };

        const menu = dbGet<any>('SELECT * FROM menus WHERE week_start = ?', [weekStart]);
        if (!menu) return reply.status(404).send({ message: 'Menu not found' });

        dbRun(
            `UPDATE menus SET published = 1, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
            [menu.id]
        );

        return buildMenuResponse(dbGet<any>('SELECT * FROM menus WHERE id = ?', [menu.id])!);
    });
};

function formatIssue(i: any) {
    return {
        id: i.id, companyId: i.company_id ?? undefined, orderId: i.order_id ?? undefined,
        title: i.title, description: i.description, severity: i.severity, status: i.status,
        createdAt: i.created_at, updatedAt: i.updated_at,
    };
}

function buildMenuResponse(menu: any) {
    const mealRows = dbAll<any>(
        `SELECT mm.date, mm.cutoff_time, m.* FROM menu_meals mm
     JOIN meals m ON m.id = mm.meal_id
     WHERE mm.menu_id = ? ORDER BY mm.date, m.name`,
        [menu.id]
    );

    const dateMap = new Map<string, any>();
    for (const r of mealRows) {
        if (!dateMap.has(r.date)) dateMap.set(r.date, { date: r.date, cutoffTime: r.cutoff_time, meals: [] });
        dateMap.get(r.date)!.meals.push({
            id: r.id, name: r.name, description: r.description, price: r.price,
            spiceLevel: r.spice_level, allergens: JSON.parse(r.allergens ?? '[]'),
            dietary: JSON.parse(r.dietary ?? '[]'), imageUrl: r.image_url ?? undefined,
            available: r.available === 1,
        });
    }

    return {
        id: menu.id, weekStart: menu.week_start,
        published: menu.published === 1, publishedAt: menu.published_at ?? undefined,
        days: Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    };
}

export default opsRoutes;