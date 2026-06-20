/**
 * src/routes/hr.ts
 * GET  /api/v1/hr/orders
 * GET  /api/v1/hr/employees
 * POST /api/v1/hr/employees
 * PATCH /api/v1/hr/employees/:id
 * DELETE /api/v1/hr/employees/:id
 * GET  /api/v1/hr/rules
 * PATCH /api/v1/hr/rules
 * GET  /api/v1/hr/billing
 * GET  /api/v1/hr/reports
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';


function toDateStr(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
const addEmployeeSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  department: z.string().optional(),
});

const rulesSchema = z.object({
  dailyAmount: z.number().positive().optional(),
  monthlyCapEnabled: z.boolean().optional(),
  monthlyCap: z.number().positive().nullable().optional(),
  mealType: z.string().optional(),
  allowTopUps: z.boolean().optional(),
  maxTopUp: z.number().nonnegative().optional(),
  maxMealsPerDay: z.number().int().min(1).max(5).optional(),
  allowAddOns: z.boolean().optional(),
  eligibleDays: z.array(z.string()).optional(),
});

/** Returns [firstDayOfMonth, firstDayOfNextMonth) as YYYY-MM-DD strings, for a "YYYY-MM" key. */
function monthRange(yearMonth: string): [string, string] {
  const [y, m] = yearMonth.split('-').map(Number);
  const start = `${yearMonth}-01`;
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return [start, nextMonth];
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

const hrRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/hr/orders
  fastify.get('/orders', async (req) => {
    const user = await req.requirePermission('orders:read');
    if (!user.companyId) return { orders: [], total: 0, page: 1, perPage: 50, totalAmount: 0 };

    const query = req.query as Record<string, string>;
    const page = parseInt(query.page ?? '1', 10);
    const perPage = Math.min(parseInt(query.perPage ?? '50', 10), 100);
    const offset = (page - 1) * perPage;

    const conditions = [`o.company_id = $1`];
    const params: unknown[] = [user.companyId];

    if (query.startDate) { params.push(query.startDate); conditions.push(`o.date >= $${params.length}`); }
    if (query.endDate)   { params.push(query.endDate);   conditions.push(`o.date <= $${params.length}`); }
    if (query.status)    { params.push(query.status);    conditions.push(`o.status = $${params.length}`); }

    const where = conditions.join(' AND ');

    const total = (await dbGet<{ cnt: string }>(
      `SELECT COUNT(*) as cnt FROM orders o WHERE ${where}`, params
    ));
    const totalCount = total?.cnt ? parseInt(total.cnt, 10) : 0;

    const totalAmountRow = await dbGet<{ sum: string }>(
      `SELECT COALESCE(SUM(total_amount), 0) as sum FROM orders o WHERE ${where}`, params
    );
    const totalAmount = totalAmountRow?.sum ? parseInt(totalAmountRow.sum, 10) : 0;

    const limitParamIdx = params.length + 1;
    const offsetParamIdx = params.length + 2;
    const orders = await dbAll<any>(
      `SELECT o.*, u.name as employee_name, u.email as employee_email
       FROM orders o JOIN users u ON u.id = o.user_id
       WHERE ${where}
       ORDER BY o.created_at DESC LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
      [...params, perPage, offset]
    );

    return {
      orders: orders.map(o => ({
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
        employeeName: o.employee_name,
        employeeEmail: o.employee_email,
        createdAt: o.created_at,
        updatedAt: o.updated_at,
      })),
      total: totalCount,
      page,
      perPage,
      totalAmount,
      filters: { startDate: query.startDate, endDate: query.endDate, status: query.status, department: query.department },
    };
  });

  // GET /api/v1/hr/employees
  fastify.get('/employees', async (req) => {
    const user = await req.requirePermission('employees:read');
    if (!user.companyId) return { employees: [], total: 0 };

    const employees = await dbAll<any>(
      `SELECT u.id, u.email, u.name, u.status, u.created_at,
              COUNT(o.id) as order_count
       FROM users u
       LEFT JOIN orders o ON o.user_id = u.id
       WHERE u.company_id = $1 AND u.portal = 'employee'
       GROUP BY u.id ORDER BY u.name`,
      [user.companyId]
    );

    return {
      employees: employees.map(e => ({
        id: e.id,
        email: e.email,
        name: e.name,
        status: e.status,
        orderCount: parseInt(e.order_count, 10),
        createdAt: e.created_at,
      })),
      total: employees.length,
    };
  });

  // POST /api/v1/hr/employees
  fastify.post('/employees', async (req, reply) => {
    const user = await req.requirePermission('employees:write');
    if (!user.companyId) return reply.status(403).send({ message: 'No company' });

    const body = addEmployeeSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: 'Invalid employee data', errors: body.error.flatten() });

    const { email, name } = body.data;

    const existing = await dbGet('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) return reply.status(409).send({ message: 'User with this email already exists' });

    const id = nanoid();
    await dbRun(
      `INSERT INTO users (id, email, name, portal, company_id, status)
       VALUES ($1, $2, $3, 'employee', $4, 'active')`,
      [id, email, name, user.companyId]
    );

    // Assign employee role
    const empRole = await dbGet<{ id: string }>(`SELECT id FROM roles WHERE id = 'role-employee'`);
    if (empRole) {
      await dbRun(
        `INSERT INTO role_assignments (id, user_id, role_id, assigned_by, status)
         VALUES ($1, $2, 'role-employee', $3, 'active')`,
        [nanoid(), id, user.id]
      );
    }

    return reply.status(201).send({
      employee: { id, email, name, status: 'active', orderCount: 0, createdAt: new Date().toISOString() },
    });
  });

  // PATCH /api/v1/hr/employees/:id
  fastify.patch('/employees/:id', async (req, reply) => {
    const user = await req.requirePermission('employees:write');
    const { id } = req.params as { id: string };

    const emp = await dbGet<any>('SELECT * FROM users WHERE id = $1 AND company_id = $2', [id, user.companyId]);
    if (!emp) return reply.status(404).send({ message: 'Employee not found' });

    const body = z.object({
      name: z.string().optional(),
      status: z.enum(['active', 'suspended', 'deactivated']).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: 'Invalid data' });

    if (body.data.name) await dbRun(`UPDATE users SET name = $1, updated_at = now() WHERE id = $2`, [body.data.name, id]);
    if (body.data.status) await dbRun(`UPDATE users SET status = $1, updated_at = now() WHERE id = $2`, [body.data.status, id]);

    const updated = await dbGet<any>('SELECT * FROM users WHERE id = $1', [id]);
    return { employee: { id: updated.id, email: updated.email, name: updated.name, status: updated.status } };
  });

  // DELETE /api/v1/hr/employees/:id
  fastify.delete('/employees/:id', async (req, reply) => {
    const user = await req.requirePermission('employees:delete');
    const { id } = req.params as { id: string };

    const emp = await dbGet('SELECT id FROM users WHERE id = $1 AND company_id = $2', [id, user.companyId]);
    if (!emp) return reply.status(404).send({ message: 'Employee not found' });

    await dbRun(`UPDATE users SET status = 'deactivated', updated_at = now() WHERE id = $1`, [id]);
    return { success: true };
  });

  // GET /api/v1/hr/rules
  fastify.get('/rules', async (req, reply) => {
    const user = await req.requirePermission('rules:read');
    if (!user.companyId) {
      return reply.status(404).send({ message: 'No company associated with account' });
    }

    const rules = await dbGet<any>('SELECT * FROM allowance_rules WHERE company_id = $1', [user.companyId]);
    if (!rules) {
      return {
        dailyAmount: 2500, monthlyCapEnabled: false, mealType: 'lunch',
        allowTopUps: true, maxTopUp: 5000, maxMealsPerDay: 1, allowAddOns: false,
        eligibleDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      };
    }

    return formatRules(rules);
  });

  // PATCH /api/v1/hr/rules
  fastify.patch('/rules', async (req, reply) => {
    const user = await req.requirePermission('rules:write');
    if (!user.companyId) return reply.status(403).send({ message: 'No company' });

    const body = rulesSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: 'Invalid rules data', errors: body.error.flatten() });

    const existing = await dbGet('SELECT id FROM allowance_rules WHERE company_id = $1', [user.companyId]);
    const d = body.data;

    if (!existing) {
      await dbRun(
        `INSERT INTO allowance_rules (id, company_id, daily_amount, monthly_cap_enabled, monthly_cap, meal_type, allow_top_ups, max_top_up, max_meals_per_day, allow_add_ons, eligible_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [nanoid(), user.companyId,
         d.dailyAmount ?? 2500, d.monthlyCapEnabled ?? false, d.monthlyCap ?? null,
         d.mealType ?? 'lunch', d.allowTopUps ?? true, d.maxTopUp ?? 5000,
         d.maxMealsPerDay ?? 1, d.allowAddOns ?? false,
         JSON.stringify(d.eligibleDays ?? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])]
      );
    } else {
      const updates: string[] = [];
      const params: unknown[] = [];
      if (d.dailyAmount !== undefined)       { params.push(d.dailyAmount);       updates.push(`daily_amount = $${params.length}`); }
      if (d.monthlyCapEnabled !== undefined) { params.push(d.monthlyCapEnabled); updates.push(`monthly_cap_enabled = $${params.length}`); }
      if (d.monthlyCap !== undefined)        { params.push(d.monthlyCap);        updates.push(`monthly_cap = $${params.length}`); }
      if (d.mealType !== undefined)          { params.push(d.mealType);          updates.push(`meal_type = $${params.length}`); }
      if (d.allowTopUps !== undefined)       { params.push(d.allowTopUps);       updates.push(`allow_top_ups = $${params.length}`); }
      if (d.maxTopUp !== undefined)          { params.push(d.maxTopUp);          updates.push(`max_top_up = $${params.length}`); }
      if (d.maxMealsPerDay !== undefined)    { params.push(d.maxMealsPerDay);    updates.push(`max_meals_per_day = $${params.length}`); }
      if (d.allowAddOns !== undefined)       { params.push(d.allowAddOns);       updates.push(`allow_add_ons = $${params.length}`); }
      if (d.eligibleDays !== undefined)      { params.push(JSON.stringify(d.eligibleDays)); updates.push(`eligible_days = $${params.length}`); }

      if (updates.length) {
        updates.push('updated_at = now()');
        params.push(user.companyId);
        await dbRun(`UPDATE allowance_rules SET ${updates.join(', ')} WHERE company_id = $${params.length}`, params);
      }
    }

    const updated = await dbGet<any>('SELECT * FROM allowance_rules WHERE company_id = $1', [user.companyId]);
    return formatRules(updated);
  });

  // GET /api/v1/hr/billing
  fastify.get('/billing', async (req) => {
    const user = await req.requirePermission('billing:read');
    if (!user.companyId) return { currentDue: 0, invoices: [] };

    const currentMonth = new Date().toISOString().slice(0, 7);
    const [curStart, curEnd] = monthRange(currentMonth);
    const currentDueRow = await dbGet<{ sum: string }>(
      `SELECT COALESCE(SUM(allowance_covered), 0) as sum FROM orders
       WHERE company_id = $1 AND date >= $2 AND date < $3 AND status NOT IN ('cancelled','failed')`,
      [user.companyId, curStart, curEnd]
    );
    const currentDue = currentDueRow?.sum ? parseInt(currentDueRow.sum, 10) : 0;

    // Generate invoice history (last 3 months)
    const invoices = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(); d.setMonth(d.getMonth() - i);
      const ym = d.toISOString().slice(0, 7);
      const [start, end] = monthRange(ym);
      const totalRow = await dbGet<{ sum: string }>(
        `SELECT COALESCE(SUM(allowance_covered), 0) as sum FROM orders
         WHERE company_id = $1 AND date >= $2 AND date < $3 AND status NOT IN ('cancelled','failed')`,
        [user.companyId, start, end]
      );
      const total = totalRow?.sum ? parseInt(totalRow.sum, 10) : 0;
      if (total > 0) {
        invoices.push({ id: `inv-${ym}`, period: ym, total, status: 'paid', dueDate: `${ym}-07` });
      }
    }

    return { currentDue, currentMonth, invoices };
  });

  // GET /api/v1/hr/reports
  fastify.get('/reports', async (req) => {
    const user = await req.requirePermission('reports:read');
    if (!user.companyId) return { participation: [], spend: [] };

    // Last 8 weeks participation (approximate by calendar month-week bucket)
    const weeks: Array<{ week: string; orders: number; employees: number }> = [];
    for (let w = 7; w >= 0; w--) {
      const d = new Date(); d.setDate(d.getDate() - w * 7);
      const weekStartDate = new Date(d); weekStartDate.setDate(d.getDate() - 6);
      const startStr = weekStartDate.toISOString().slice(0, 10);
      const endStr = d.toISOString().slice(0, 10);
      const wk = startStr.slice(0, 7);

      const row = await dbGet<{ orders: string; employees: string }>(
        `SELECT COUNT(*) as orders, COUNT(DISTINCT user_id) as employees
         FROM orders WHERE company_id = $1 AND date >= $2 AND date <= $3 AND status != 'cancelled'`,
        [user.companyId, startStr, endStr]
      );
      weeks.push({
        week: wk,
        orders: row?.orders ? parseInt(row.orders, 10) : 0,
        employees: row?.employees ? parseInt(row.employees, 10) : 0,
      });
    }

    // Top meals
    const topMeals = await dbAll<{ meal_name: string; cnt: string }>(
      `SELECT meal_name, COUNT(*) as cnt FROM orders
       WHERE company_id = $1 AND status != 'cancelled'
       GROUP BY meal_name ORDER BY cnt DESC LIMIT 5`,
      [user.companyId]
    );

    // Recent issues
    const issues = await dbAll<any>(
      `SELECT * FROM issues WHERE company_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [user.companyId]
    );

    return {
      participation: weeks,
      topMeals: topMeals.map(m => ({ name: m.meal_name, orders: parseInt(m.cnt, 10) })),
      issues: issues.map(i => ({ id: i.id, title: i.title, severity: i.severity, status: i.status, createdAt: i.created_at })),
    };
  });
};

function formatRules(r: any) {
  return {
    dailyAmount: r.daily_amount,
    monthlyCapEnabled: r.monthly_cap_enabled === true,
    monthlyCap: r.monthly_cap ?? undefined,
    mealType: r.meal_type,
    allowTopUps: r.allow_top_ups === true,
    maxTopUp: r.max_top_up,
    maxMealsPerDay: r.max_meals_per_day,
    allowAddOns: r.allow_add_ons === true,
    eligibleDays: asArray(r.eligible_days),
  };
}

export default hrRoutes;