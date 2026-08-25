/**
 * src/routes/hr-holidays.ts
 * GET    /api/v1/hr/holidays
 * POST   /api/v1/hr/holidays
 * DELETE /api/v1/hr/holidays/:id
 * PATCH  /api/v1/hr/eligible-days
 *
 * HR's controls for "which days do we actually order food" — a weekly
 * pattern (eligible_days, e.g. no weekends) plus specific one-off dates
 * (company_holidays, e.g. a public holiday or a company shutdown day).
 * Both are enforced in routes/employee.ts POST /orders.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const holidaySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    label: z.string().min(1),
});

const eligibleDaysSchema = z.object({
    eligibleDays: z.array(z.enum(DAYS)).min(1, 'At least one working day is required'),
});

const hrHolidaysRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/holidays', async (req, reply) => {
        const user = await req.requirePermission('rules:manage');
        if (!user.companyId) return reply.status(403).send({ message: 'No company associated with account' });

        const rows = await dbAll<any>(
            `SELECT * FROM company_holidays WHERE company_id = $1 AND date >= CURRENT_DATE ORDER BY date`,
            [user.companyId]
        );
        return { holidays: rows.map((h) => ({ id: h.id, date: h.date, label: h.label })) };
    });

    fastify.post('/holidays', async (req, reply) => {
        const user = await req.requirePermission('rules:manage');
        if (!user.companyId) return reply.status(403).send({ message: 'No company associated with account' });

        const body = holidaySchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid holiday data', errors: body.error.flatten() });

        const id = nanoid();
        try {
            await dbRun(
                `INSERT INTO company_holidays (id, company_id, date, label) VALUES ($1, $2, $3, $4)`,
                [id, user.companyId, body.data.date, body.data.label]
            );
        } catch (err: any) {
            if (err?.code === '23505') return reply.status(409).send({ message: 'A holiday is already set for that date' });
            throw err;
        }

        return reply.status(201).send({ holiday: { id, date: body.data.date, label: body.data.label } });
    });

    fastify.delete('/holidays/:id', async (req, reply) => {
        const user = await req.requirePermission('rules:manage');
        const { id } = req.params as { id: string };

        const holiday = await dbGet('SELECT id FROM company_holidays WHERE id = $1 AND company_id = $2', [id, user.companyId]);
        if (!holiday) return reply.status(404).send({ message: 'Holiday not found' });

        await dbRun('DELETE FROM company_holidays WHERE id = $1', [id]);
        return { success: true };
    });

    // PATCH /api/v1/hr/eligible-days — the weekly working-day pattern
    fastify.patch('/eligible-days', async (req, reply) => {
        const user = await req.requirePermission('rules:manage');
        if (!user.companyId) return reply.status(403).send({ message: 'No company associated with account' });

        const body = eligibleDaysSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid data', errors: body.error.flatten() });

        await dbRun(
            `UPDATE allowance_rules SET eligible_days = $1, updated_at = now() WHERE company_id = $2`,
            [JSON.stringify(body.data.eligibleDays), user.companyId]
        );

        return { eligibleDays: body.data.eligibleDays };
    });

    fastify.get('/eligible-days', async (req, reply) => {
        const user = await req.requirePermission('rules:manage');
        if (!user.companyId) return reply.status(403).send({ message: 'No company associated with account' });

        const rules = await dbGet<any>('SELECT eligible_days FROM allowance_rules WHERE company_id = $1', [user.companyId]);
        const eligibleDays = rules?.eligible_days
            ? (typeof rules.eligible_days === 'string' ? JSON.parse(rules.eligible_days) : rules.eligible_days)
            : DAYS.slice(1, 6); // Mon-Fri fallback

        return { eligibleDays };
    });
};

export default hrHolidaysRoutes;
