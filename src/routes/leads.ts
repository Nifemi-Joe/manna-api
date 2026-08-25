/**
 * src/routes/leads.ts
 * POST /api/v1/leads                    (public — pilot request form)
 * GET  /api/v1/admin/leads              (admin — list)
 * GET  /api/v1/admin/leads/:id          (admin — detail)
 * PATCH /api/v1/admin/leads/:id         (admin — update status/notes)
 * POST /api/v1/admin/leads/:id/approve  (admin — create company + HR user, send onboarding email)
 *
 * UPDATED: a new lead now also creates an in-app notification for every
 * admin user, on top of the existing email to SALES_NOTIFICATION_EMAIL
 * — so it shows up in the bell dropdown immediately, not just inbox.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';
import { sendPilotRequestNotification, sendOnboardingEmail } from '../services/email.js';
import { notifyPortal } from '../services/notifications.js';

const createLeadSchema = z.object({
    companyName: z.string().min(2),
    contactName: z.string().min(2),
    email: z.string().email(),
    employees: z.string().min(1),
});

const approveLeadSchema = z.object({
    plan: z.enum(['pilot', 'starter', 'growth', 'enterprise']).default('pilot'),
    dailyAmountLunch: z.number().positive().default(2500),
    dailyAmountBreakfast: z.number().positive().optional(),
    address: z.string().default(''),
    city: z.string().default('Lagos'),
    hrName: z.string().min(2),
    hrEmail: z.string().email(),
});

function formatLead(l: any) {
    return {
        id: l.id,
        companyName: l.company_name,
        contactName: l.contact_name,
        email: l.email,
        teamSize: l.team_size,
        status: l.status,
        notes: l.notes ?? undefined,
        approvedCompanyId: l.approved_company_id ?? undefined,
        createdAt: l.created_at,
        updatedAt: l.updated_at,
    };
}

export const publicLeadRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/', async (req, reply) => {
        const body = createLeadSchema.safeParse(req.body);
        if (!body.success) {
            return reply.status(400).send({ message: 'Please fill in all fields correctly', errors: body.error.flatten() });
        }

        const { companyName, contactName, email, employees } = body.data;
        const id = nanoid();

        await dbRun(
            `INSERT INTO leads (id, company_name, contact_name, email, team_size, status)
             VALUES ($1, $2, $3, $4, $5, 'new')`,
            [id, companyName, contactName, email, employees]
        );

        await sendPilotRequestNotification({ id, companyName, contactName, email, teamSize: employees });

        // NEW: in-app notification for every admin, not just email.
        await notifyPortal('admin', {
            kind: 'lead',
            title: 'New pilot request',
            body: `${companyName} (${contactName}) requested a pilot — ${employees} employees.`,
            link: `/admin/leads`,
        });

        return reply.status(201).send({ message: 'Pilot request received', leadId: id });
    });
};

export const adminLeadRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/', async (req) => {
        await req.requirePermission('companies:read');
        const query = req.query as Record<string, string>;

        const conditions: string[] = [];
        const params: unknown[] = [];
        if (query.status) { params.push(query.status); conditions.push(`status = $${params.length}`); }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const leads = await dbAll<any>(`SELECT * FROM leads ${where} ORDER BY created_at DESC`, params);
        return { leads: leads.map(formatLead), total: leads.length };
    });

    fastify.get('/:id', async (req, reply) => {
        await req.requirePermission('companies:read');
        const { id } = req.params as { id: string };

        const lead = await dbGet<any>('SELECT * FROM leads WHERE id = $1', [id]);
        if (!lead) return reply.status(404).send({ message: 'Lead not found' });

        return { lead: formatLead(lead) };
    });

    fastify.patch('/:id', async (req, reply) => {
        await req.requirePermission('companies:write');
        const { id } = req.params as { id: string };

        const lead = await dbGet('SELECT id FROM leads WHERE id = $1', [id]);
        if (!lead) return reply.status(404).send({ message: 'Lead not found' });

        const body = z.object({
            status: z.enum(['new', 'contacted', 'approved', 'declined']).optional(),
            notes: z.string().optional(),
        }).safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid data' });

        const updates: string[] = [];
        const params: unknown[] = [];
        if (body.data.status) { params.push(body.data.status); updates.push(`status = $${params.length}`); }
        if (body.data.notes !== undefined) { params.push(body.data.notes); updates.push(`notes = $${params.length}`); }

        if (updates.length) {
            updates.push('updated_at = now()');
            params.push(id);
            await dbRun(`UPDATE leads SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
        }

        const updated = await dbGet<any>('SELECT * FROM leads WHERE id = $1', [id]);
        return { lead: formatLead(updated) };
    });

    fastify.post('/:id/approve', async (req, reply) => {
        await req.requirePermission('companies:write');
        const { id } = req.params as { id: string };

        const lead = await dbGet<any>('SELECT * FROM leads WHERE id = $1', [id]);
        if (!lead) return reply.status(404).send({ message: 'Lead not found' });
        if (lead.status === 'approved') return reply.status(409).send({ message: 'Lead already approved' });

        const body = approveLeadSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid approval data', errors: body.error.flatten() });

        const { plan, dailyAmountLunch, dailyAmountBreakfast, address, city, hrName, hrEmail } = body.data;

        const existingHr = await dbGet('SELECT id FROM users WHERE email = $1', [hrEmail]);
        if (existingHr) return reply.status(409).send({ message: 'A user with this HR email already exists' });

        const companyId = nanoid();
        const slug = lead.company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        await dbRun(
            `INSERT INTO companies (id, name, slug, plan, status, address, city) VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
            [companyId, lead.company_name, slug, plan, address, city]
        );

        await dbRun(
            `INSERT INTO allowance_rules (id, company_id, daily_amount, daily_amount_breakfast)
             VALUES ($1, $2, $3, $4)`,
            [nanoid(), companyId, dailyAmountLunch, dailyAmountBreakfast ?? null]
        );

        const hrUserId = nanoid();
        await dbRun(
            `INSERT INTO users (id, email, name, portal, company_id, status) VALUES ($1, $2, $3, 'hr', $4, 'active')`,
            [hrUserId, hrEmail, hrName, companyId]
        );

        const hrRole = await dbGet<{ id: string }>(`SELECT id FROM roles WHERE id = 'role-hr'`);
        if (hrRole) {
            await dbRun(
                `INSERT INTO role_assignments (id, user_id, role_id, assigned_by, status) VALUES ($1, $2, 'role-hr', 'admin', 'active')`,
                [nanoid(), hrUserId]
            );
        }

        await dbRun(
            `UPDATE leads SET status = 'approved', approved_company_id = $1, updated_at = now() WHERE id = $2`,
            [companyId, id]
        );

        await sendOnboardingEmail({ companyName: lead.company_name, hrName, hrEmail });

        const company = await dbGet<any>('SELECT * FROM companies WHERE id = $1', [companyId]);
        return reply.status(201).send({ company, hrUserId, message: `${lead.company_name} onboarded — welcome email sent to ${hrEmail}` });
    });
};
