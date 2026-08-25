/**
 * src/routes/hr-levels.ts
 * GET    /api/v1/hr/levels
 * POST   /api/v1/hr/levels
 * PATCH  /api/v1/hr/levels/:id
 * DELETE /api/v1/hr/levels/:id
 * PATCH  /api/v1/hr/employees/:id/level
 *
 * Registered under the same `/hr` prefix as hr.ts, hr-employees-bulk.ts,
 * and hr-employee-allowance.ts (see index.ts) — a separate plugin file
 * rather than editing hr.ts directly.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';

const levelSchema = z.object({
    name: z.string().min(2),
    dailyAmountLunch: z.number().positive(),
    dailyAmountBreakfast: z.number().positive().nullable().optional(),
    canOrderForOthers: z.boolean().default(false),
    overspendLimitLunch: z.number().nonnegative().nullable().optional(),
    overspendLimitBreakfast: z.number().nonnegative().nullable().optional(),
});

function formatLevel(l: any) {
    return {
        id: l.id,
        name: l.name,
        dailyAmountLunch: l.daily_amount_lunch,
        dailyAmountBreakfast: l.daily_amount_breakfast ?? null,
        canOrderForOthers: l.can_order_for_others === true,
        overspendLimitLunch: l.overspend_limit_lunch ?? null,
        overspendLimitBreakfast: l.overspend_limit_breakfast ?? null,
        employeeCount: l.employee_count != null ? parseInt(l.employee_count, 10) : undefined,
        createdAt: l.created_at,
        updatedAt: l.updated_at,
    };
}

const hrLevelsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/levels', async (req, reply) => {
        const user = await req.requirePermission('employees:read');
        if (!user.companyId) return reply.status(403).send({ message: 'No company associated with account' });

        const levels = await dbAll<any>(
            `SELECT sl.*, COUNT(u.id) as employee_count
             FROM staff_levels sl
             LEFT JOIN users u ON u.level_id = sl.id
             WHERE sl.company_id = $1
             GROUP BY sl.id ORDER BY sl.daily_amount_lunch DESC`,
            [user.companyId]
        );
        return { levels: levels.map(formatLevel) };
    });

    fastify.post('/levels', async (req, reply) => {
        const user = await req.requirePermission('employees:write');
        if (!user.companyId) return reply.status(403).send({ message: 'No company associated with account' });

        const body = levelSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid level data', errors: body.error.flatten() });

        const existing = await dbGet('SELECT id FROM staff_levels WHERE company_id = $1 AND name = $2', [user.companyId, body.data.name]);
        if (existing) return reply.status(409).send({ message: 'A level with this name already exists' });

        const id = nanoid();
        await dbRun(
            `INSERT INTO staff_levels (id, company_id, name, daily_amount_lunch, daily_amount_breakfast, can_order_for_others, overspend_limit_lunch, overspend_limit_breakfast)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                id, user.companyId, body.data.name, body.data.dailyAmountLunch,
                body.data.dailyAmountBreakfast ?? null, body.data.canOrderForOthers,
                body.data.overspendLimitLunch ?? null, body.data.overspendLimitBreakfast ?? null,
            ]
        );

        const level = await dbGet<any>('SELECT * FROM staff_levels WHERE id = $1', [id]);
        return reply.status(201).send({ level: formatLevel({ ...level, employee_count: 0 }) });
    });

    fastify.patch('/levels/:id', async (req, reply) => {
        const user = await req.requirePermission('employees:write');
        const { id } = req.params as { id: string };

        const level = await dbGet('SELECT id FROM staff_levels WHERE id = $1 AND company_id = $2', [id, user.companyId]);
        if (!level) return reply.status(404).send({ message: 'Level not found' });

        const body = levelSchema.partial().safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid level data', errors: body.error.flatten() });

        const fieldMap: Record<string, string> = {
            name: 'name',
            dailyAmountLunch: 'daily_amount_lunch',
            dailyAmountBreakfast: 'daily_amount_breakfast',
            canOrderForOthers: 'can_order_for_others',
            overspendLimitLunch: 'overspend_limit_lunch',
            overspendLimitBreakfast: 'overspend_limit_breakfast',
        };

        const updates: string[] = [];
        const params: unknown[] = [];
        for (const [key, column] of Object.entries(fieldMap)) {
            const value = (body.data as any)[key];
            if (value !== undefined) {
                params.push(value);
                updates.push(`${column} = $${params.length}`);
            }
        }

        if (updates.length) {
            updates.push('updated_at = now()');
            params.push(id);
            await dbRun(`UPDATE staff_levels SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
        }

        const updated = await dbGet<any>(
            `SELECT sl.*, COUNT(u.id) as employee_count FROM staff_levels sl LEFT JOIN users u ON u.level_id = sl.id WHERE sl.id = $1 GROUP BY sl.id`,
            [id]
        );
        return { level: formatLevel(updated) };
    });

    // Unassigns any employees on this level (back to the company
    // default) rather than blocking deletion.
    fastify.delete('/levels/:id', async (req, reply) => {
        const user = await req.requirePermission('employees:write');
        const { id } = req.params as { id: string };

        const level = await dbGet('SELECT id FROM staff_levels WHERE id = $1 AND company_id = $2', [id, user.companyId]);
        if (!level) return reply.status(404).send({ message: 'Level not found' });

        await dbRun('UPDATE users SET level_id = NULL WHERE level_id = $1', [id]);
        await dbRun('DELETE FROM staff_levels WHERE id = $1', [id]);

        return { success: true };
    });

    // Assign (or clear, via null) an employee's level
    fastify.patch('/employees/:id/level', async (req, reply) => {
        const user = await req.requirePermission('employees:write');
        const { id } = req.params as { id: string };

        const emp = await dbGet<any>('SELECT * FROM users WHERE id = $1 AND company_id = $2', [id, user.companyId]);
        if (!emp) return reply.status(404).send({ message: 'Employee not found' });

        const body = z.object({ levelId: z.string().nullable() }).safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid data' });

        if (body.data.levelId) {
            const level = await dbGet('SELECT id FROM staff_levels WHERE id = $1 AND company_id = $2', [body.data.levelId, user.companyId]);
            if (!level) return reply.status(404).send({ message: 'Level not found' });
        }

        await dbRun('UPDATE users SET level_id = $1, updated_at = now() WHERE id = $2', [body.data.levelId, id]);

        return { success: true };
    });
};

export default hrLevelsRoutes;
