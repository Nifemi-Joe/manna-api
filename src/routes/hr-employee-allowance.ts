/**
 * src/routes/hr-employee-allowance.ts
 * PATCH /api/v1/hr/employees/:id/allowance
 *
 * Registered as a separate plugin under the same `/hr` prefix as your
 * existing hr.ts and hr-employees-bulk.ts (see index.ts) — lets HR set
 * a per-employee allowance override directly from the Employees table,
 * not just via CSV/Excel bulk upload. Passing `null` for either field
 * clears the override and falls back to the company default again.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { dbGet, dbRun } from '../db/index.js';

const updateAllowanceSchema = z.object({
    allowanceOverrideLunch: z.number().positive().nullable().optional(),
    allowanceOverrideBreakfast: z.number().positive().nullable().optional(),
});

const hrEmployeeAllowanceRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.patch('/employees/:id/allowance', async (req, reply) => {
        const user = await req.requirePermission('employees:write');
        const { id } = req.params as { id: string };

        const emp = await dbGet<any>('SELECT * FROM users WHERE id = $1 AND company_id = $2', [id, user.companyId]);
        if (!emp) return reply.status(404).send({ message: 'Employee not found' });

        const body = updateAllowanceSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid allowance data', errors: body.error.flatten() });

        const updates: string[] = [];
        const params: unknown[] = [];
        if (body.data.allowanceOverrideLunch !== undefined) {
            params.push(body.data.allowanceOverrideLunch);
            updates.push(`allowance_override_lunch = $${params.length}`);
        }
        if (body.data.allowanceOverrideBreakfast !== undefined) {
            params.push(body.data.allowanceOverrideBreakfast);
            updates.push(`allowance_override_breakfast = $${params.length}`);
        }

        if (updates.length) {
            updates.push('updated_at = now()');
            params.push(id);
            await dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
        }

        const updated = await dbGet<any>('SELECT * FROM users WHERE id = $1', [id]);
        return {
            employee: {
                id: updated.id,
                name: updated.name,
                email: updated.email,
                allowanceOverrideLunch: updated.allowance_override_lunch ?? null,
                allowanceOverrideBreakfast: updated.allowance_override_breakfast ?? null,
            },
        };
    });
};

export default hrEmployeeAllowanceRoutes;
