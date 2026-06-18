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
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';
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
const hrRoutes = async (fastify) => {
    // GET /api/v1/hr/orders
    fastify.get('/orders', async (req) => {
        const user = await req.requirePermission('orders:read');
        if (!user.companyId)
            return { orders: [], total: 0, page: 1, perPage: 50, totalAmount: 0 };
        const query = req.query;
        const page = parseInt(query.page ?? '1', 10);
        const perPage = Math.min(parseInt(query.perPage ?? '50', 10), 100);
        const offset = (page - 1) * perPage;
        const conditions = [`o.company_id = ?`];
        const params = [user.companyId];
        if (query.startDate) {
            conditions.push(`o.date >= ?`);
            params.push(query.startDate);
        }
        if (query.endDate) {
            conditions.push(`o.date <= ?`);
            params.push(query.endDate);
        }
        if (query.status) {
            conditions.push(`o.status = ?`);
            params.push(query.status);
        }
        const where = conditions.join(' AND ');
        const total = (dbGet(`SELECT COUNT(*) as cnt FROM orders o WHERE ${where}`, params))?.cnt ?? 0;
        const totalAmount = (dbGet(`SELECT COALESCE(SUM(total_amount), 0) as sum FROM orders o WHERE ${where}`, params))?.sum ?? 0;
        const orders = dbAll(`SELECT o.*, u.name as employee_name, u.email as employee_email
       FROM orders o JOIN users u ON u.id = o.user_id
       WHERE ${where}
       ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, [...params, perPage, offset]);
        return {
            orders: orders.map(o => ({
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
                employeeName: o.employee_name,
                employeeEmail: o.employee_email,
                createdAt: o.created_at,
                updatedAt: o.updated_at,
            })),
            total,
            page,
            perPage,
            totalAmount,
            filters: { startDate: query.startDate, endDate: query.endDate, status: query.status, department: query.department },
        };
    });
    // GET /api/v1/hr/employees
    fastify.get('/employees', async (req) => {
        const user = await req.requirePermission('employees:read');
        if (!user.companyId)
            return { employees: [], total: 0 };
        const employees = dbAll(`SELECT u.id, u.email, u.name, u.status, u.created_at,
              COUNT(o.id) as order_count
       FROM users u
       LEFT JOIN orders o ON o.user_id = u.id
       WHERE u.company_id = ? AND u.portal = 'employee'
       GROUP BY u.id ORDER BY u.name`, [user.companyId]);
        return {
            employees: employees.map(e => ({
                id: e.id,
                email: e.email,
                name: e.name,
                status: e.status,
                orderCount: e.order_count,
                createdAt: e.created_at,
            })),
            total: employees.length,
        };
    });
    // POST /api/v1/hr/employees
    fastify.post('/employees', async (req, reply) => {
        const user = await req.requirePermission('employees:write');
        if (!user.companyId)
            return reply.status(403).send({ message: 'No company' });
        const body = addEmployeeSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid employee data', errors: body.error.flatten() });
        const { email, name } = body.data;
        const existing = dbGet('SELECT id FROM users WHERE email = ?', [email]);
        if (existing)
            return reply.status(409).send({ message: 'User with this email already exists' });
        const id = nanoid();
        dbRun(`INSERT INTO users (id, email, name, portal, company_id, status)
       VALUES (?, ?, ?, 'employee', ?, 'active')`, [id, email, name, user.companyId]);
        // Assign employee role
        const empRole = dbGet(`SELECT id FROM roles WHERE id = 'role-employee'`);
        if (empRole) {
            dbRun(`INSERT INTO role_assignments (id, user_id, role_id, assigned_by, status)
         VALUES (?, ?, 'role-employee', ?, 'active')`, [nanoid(), id, user.id]);
        }
        return reply.status(201).send({
            employee: { id, email, name, status: 'active', orderCount: 0, createdAt: new Date().toISOString() },
        });
    });
    // PATCH /api/v1/hr/employees/:id
    fastify.patch('/employees/:id', async (req, reply) => {
        const user = await req.requirePermission('employees:write');
        const { id } = req.params;
        const emp = dbGet('SELECT * FROM users WHERE id = ? AND company_id = ?', [id, user.companyId]);
        if (!emp)
            return reply.status(404).send({ message: 'Employee not found' });
        const body = z.object({
            name: z.string().optional(),
            status: z.enum(['active', 'suspended', 'deactivated']).optional(),
        }).safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid data' });
        if (body.data.name)
            dbRun(`UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?`, [body.data.name, id]);
        if (body.data.status)
            dbRun(`UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?`, [body.data.status, id]);
        const updated = dbGet('SELECT * FROM users WHERE id = ?', [id]);
        return { employee: { id: updated.id, email: updated.email, name: updated.name, status: updated.status } };
    });
    // DELETE /api/v1/hr/employees/:id
    fastify.delete('/employees/:id', async (req, reply) => {
        const user = await req.requirePermission('employees:delete');
        const { id } = req.params;
        const emp = dbGet('SELECT id FROM users WHERE id = ? AND company_id = ?', [id, user.companyId]);
        if (!emp)
            return reply.status(404).send({ message: 'Employee not found' });
        dbRun(`UPDATE users SET status = 'deactivated', updated_at = datetime('now') WHERE id = ?`, [id]);
        return { success: true };
    });
    // GET /api/v1/hr/rules
    fastify.get('/rules', async (req) => {
        const user = await req.requirePermission('rules:read');
        if (!user.companyId)
            return reply404();
        const rules = dbGet('SELECT * FROM allowance_rules WHERE company_id = ?', [user.companyId]);
        if (!rules)
            return { dailyAmount: 2500, monthlyCapEnabled: false, mealType: 'lunch', allowTopUps: true, maxTopUp: 5000, maxMealsPerDay: 1, allowAddOns: false, eligibleDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] };
        return formatRules(rules);
    });
    // PATCH /api/v1/hr/rules
    fastify.patch('/rules', async (req, reply) => {
        const user = await req.requirePermission('rules:write');
        if (!user.companyId)
            return reply.status(403).send({ message: 'No company' });
        const body = rulesSchema.safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: 'Invalid rules data', errors: body.error.flatten() });
        const existing = dbGet('SELECT id FROM allowance_rules WHERE company_id = ?', [user.companyId]);
        const d = body.data;
        if (!existing) {
            dbRun(`INSERT INTO allowance_rules (id, company_id, daily_amount, monthly_cap_enabled, monthly_cap, meal_type, allow_top_ups, max_top_up, max_meals_per_day, allow_add_ons, eligible_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [nanoid(), user.companyId,
                d.dailyAmount ?? 2500, d.monthlyCapEnabled ? 1 : 0, d.monthlyCap ?? null,
                d.mealType ?? 'lunch', d.allowTopUps ? 1 : 1, d.maxTopUp ?? 5000,
                d.maxMealsPerDay ?? 1, d.allowAddOns ? 1 : 0,
                JSON.stringify(d.eligibleDays ?? ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])]);
        }
        else {
            const updates = [];
            const params = [];
            if (d.dailyAmount !== undefined) {
                updates.push('daily_amount = ?');
                params.push(d.dailyAmount);
            }
            if (d.monthlyCapEnabled !== undefined) {
                updates.push('monthly_cap_enabled = ?');
                params.push(d.monthlyCapEnabled ? 1 : 0);
            }
            if (d.monthlyCap !== undefined) {
                updates.push('monthly_cap = ?');
                params.push(d.monthlyCap);
            }
            if (d.mealType !== undefined) {
                updates.push('meal_type = ?');
                params.push(d.mealType);
            }
            if (d.allowTopUps !== undefined) {
                updates.push('allow_top_ups = ?');
                params.push(d.allowTopUps ? 1 : 0);
            }
            if (d.maxTopUp !== undefined) {
                updates.push('max_top_up = ?');
                params.push(d.maxTopUp);
            }
            if (d.maxMealsPerDay !== undefined) {
                updates.push('max_meals_per_day = ?');
                params.push(d.maxMealsPerDay);
            }
            if (d.allowAddOns !== undefined) {
                updates.push('allow_add_ons = ?');
                params.push(d.allowAddOns ? 1 : 0);
            }
            if (d.eligibleDays !== undefined) {
                updates.push('eligible_days = ?');
                params.push(JSON.stringify(d.eligibleDays));
            }
            if (updates.length) {
                updates.push('updated_at = datetime(\'now\')');
                params.push(user.companyId);
                dbRun(`UPDATE allowance_rules SET ${updates.join(', ')} WHERE company_id = ?`, params);
            }
        }
        const updated = dbGet('SELECT * FROM allowance_rules WHERE company_id = ?', [user.companyId]);
        return formatRules(updated);
    });
    // GET /api/v1/hr/billing
    fastify.get('/billing', async (req) => {
        const user = await req.requirePermission('billing:read');
        if (!user.companyId)
            return { currentDue: 0, invoices: [] };
        const currentMonth = new Date().toISOString().slice(0, 7);
        const currentDue = (dbGet(`SELECT COALESCE(SUM(allowance_covered), 0) as sum FROM orders WHERE company_id = ? AND date LIKE ? AND status NOT IN ('cancelled','failed')`, [user.companyId, `${currentMonth}%`]))?.sum ?? 0;
        // Generate mock invoice history (last 3 months)
        const invoices = [];
        for (let i = 1; i <= 3; i++) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            const ym = d.toISOString().slice(0, 7);
            const total = (dbGet(`SELECT COALESCE(SUM(allowance_covered), 0) as sum FROM orders WHERE company_id = ? AND date LIKE ? AND status NOT IN ('cancelled','failed')`, [user.companyId, `${ym}%`]))?.sum ?? 0;
            if (total > 0) {
                invoices.push({ id: `inv-${ym}`, period: ym, total, status: 'paid', dueDate: `${ym}-07` });
            }
        }
        return { currentDue, currentMonth, invoices };
    });
    // GET /api/v1/hr/reports
    fastify.get('/reports', async (req) => {
        const user = await req.requirePermission('reports:read');
        if (!user.companyId)
            return { participation: [], spend: [] };
        // Last 8 weeks participation
        const weeks = [];
        for (let w = 7; w >= 0; w--) {
            const d = new Date();
            d.setDate(d.getDate() - w * 7);
            const wk = d.toISOString().slice(0, 10).slice(0, 7);
            const row = dbGet(`SELECT COUNT(*) as orders, COUNT(DISTINCT user_id) as employees
         FROM orders WHERE company_id = ? AND date LIKE ? AND status != 'cancelled'`, [user.companyId, `${wk}%`]);
            weeks.push({ week: wk, orders: row?.orders ?? 0, employees: row?.employees ?? 0 });
        }
        // Top meals
        const topMeals = dbAll(`SELECT meal_name, COUNT(*) as cnt FROM orders
       WHERE company_id = ? AND status != 'cancelled'
       GROUP BY meal_name ORDER BY cnt DESC LIMIT 5`, [user.companyId]);
        // Recent issues
        const issues = dbAll(`SELECT * FROM issues WHERE company_id = ? ORDER BY created_at DESC LIMIT 10`, [user.companyId]);
        return {
            participation: weeks,
            topMeals: topMeals.map(m => ({ name: m.meal_name, orders: m.cnt })),
            issues: issues.map(i => ({ id: i.id, title: i.title, severity: i.severity, status: i.status, createdAt: i.created_at })),
        };
    });
};
function formatRules(r) {
    return {
        dailyAmount: r.daily_amount,
        monthlyCapEnabled: r.monthly_cap_enabled === 1,
        monthlyCap: r.monthly_cap ?? undefined,
        mealType: r.meal_type,
        allowTopUps: r.allow_top_ups === 1,
        maxTopUp: r.max_top_up,
        maxMealsPerDay: r.max_meals_per_day,
        allowAddOns: r.allow_add_ons === 1,
        eligibleDays: JSON.parse(r.eligible_days ?? '[]'),
    };
}
function reply404() { return { error: 'not found' }; }
export default hrRoutes;
