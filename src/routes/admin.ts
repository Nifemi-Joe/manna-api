/**
 * src/routes/admin.ts
 * GET  /api/v1/health
 * GET  /api/v1/admin/companies
 * POST /api/v1/admin/companies
 * PATCH /api/v1/admin/companies/:id
 * GET  /api/v1/admin/users
 * PATCH /api/v1/admin/users/:id
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dbAll, dbGet, dbRun } from '../db/index.js';

const createCompanySchema = z.object({
  name: z.string().min(2),
  plan: z.enum(['pilot', 'starter', 'growth', 'enterprise']).default('pilot'),
  address: z.string().default(''),
  city: z.string().default('Lagos'),
});

// Standalone health route — registered at /api/v1/health
export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => ({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    services: { db: 'ok', auth: 'ok', payments: 'ok', delivery: 'ok' },
  }));
};

const adminRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/admin/companies
  fastify.get('/companies', async (req) => {
    await req.requirePermission('companies:read');

    const companies = await dbAll<any>(
      `SELECT c.*,
              COUNT(DISTINCT u.id) as employee_count,
              COUNT(DISTINCT o.id) as order_count,
              COALESCE(SUM(o.total_amount), 0) as lifetime_spend
       FROM companies c
       LEFT JOIN users u ON u.company_id = c.id AND u.portal = 'employee' AND u.status = 'active'
       LEFT JOIN orders o ON o.company_id = c.id AND o.status NOT IN ('cancelled','failed')
       GROUP BY c.id ORDER BY c.name`
    );

    return {
      companies: companies.map(c => ({
        id: c.id, name: c.name, slug: c.slug, plan: c.plan, status: c.status,
        address: c.address, city: c.city,
        employeeCount: parseInt(c.employee_count, 10),
        orderCount: parseInt(c.order_count, 10),
        lifetimeSpend: parseInt(c.lifetime_spend, 10),
        createdAt: c.created_at,
      })),
      total: companies.length,
    };
  });

  // POST /api/v1/admin/companies
  fastify.post('/companies', async (req, reply) => {
    await req.requirePermission('companies:write');

    const body = createCompanySchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: 'Invalid company data', errors: body.error.flatten() });

    const { name, plan, address, city } = body.data;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = nanoid();

    const existing = await dbGet('SELECT id FROM companies WHERE slug = $1', [slug]);
    if (existing) return reply.status(409).send({ message: 'Company with similar name already exists' });

    await dbRun(
      `INSERT INTO companies (id, name, slug, plan, status, address, city) VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
      [id, name, slug, plan, address, city]
    );

    // Seed allowance rules
    await dbRun(
      `INSERT INTO allowance_rules (id, company_id, daily_amount) VALUES ($1, $2, 2500)`,
      [nanoid(), id]
    );

    const company = await dbGet<any>('SELECT * FROM companies WHERE id = $1', [id]);
    return reply.status(201).send({ company });
  });

  // PATCH /api/v1/admin/companies/:id
  fastify.patch('/companies/:id', async (req, reply) => {
    await req.requirePermission('companies:write');
    const { id } = req.params as { id: string };

    const company = await dbGet('SELECT id FROM companies WHERE id = $1', [id]);
    if (!company) return reply.status(404).send({ message: 'Company not found' });

    const body = z.object({
      name: z.string().optional(),
      plan: z.enum(['pilot', 'starter', 'growth', 'enterprise']).optional(),
      status: z.enum(['active', 'suspended', 'churned']).optional(),
      address: z.string().optional(),
    }).safeParse(req.body);

    if (!body.success) return reply.status(400).send({ message: 'Invalid data' });

    const updates: string[] = [];
    const params: unknown[] = [];
    if (body.data.name)    { params.push(body.data.name);    updates.push(`name = $${params.length}`); }
    if (body.data.plan)    { params.push(body.data.plan);    updates.push(`plan = $${params.length}`); }
    if (body.data.status)  { params.push(body.data.status);  updates.push(`status = $${params.length}`); }
    if (body.data.address) { params.push(body.data.address); updates.push(`address = $${params.length}`); }

    if (updates.length) {
      updates.push('updated_at = now()');
      params.push(id);
      await dbRun(`UPDATE companies SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    }

    const updated = await dbGet<any>('SELECT * FROM companies WHERE id = $1', [id]);
    return { company: updated };
  });

  // GET /api/v1/admin/users
  fastify.get('/users', async (req) => {
    await req.requirePermission('users:read');

    const query = req.query as Record<string, string>;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.portal) { params.push(query.portal); conditions.push(`u.portal = $${params.length}`); }
    if (query.status) { params.push(query.status); conditions.push(`u.status = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const users = await dbAll<any>(
      `SELECT u.*, c.name as company_name FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
       ${where}
       ORDER BY u.created_at DESC`,
      params
    );

    return {
      users: users.map(u => ({
        id: u.id, email: u.email, name: u.name, portal: u.portal, status: u.status,
        companyId: u.company_id ?? undefined, companyName: u.company_name ?? undefined,
        createdAt: u.created_at,
      })),
      total: users.length,
    };
  });

  // PATCH /api/v1/admin/users/:id
  fastify.patch('/users/:id', async (req, reply) => {
    await req.requirePermission('users:write');
    const { id } = req.params as { id: string };

    const user = await dbGet('SELECT id FROM users WHERE id = $1', [id]);
    if (!user) return reply.status(404).send({ message: 'User not found' });

    const body = z.object({
      name: z.string().optional(),
      portal: z.enum(['employee', 'hr', 'ops', 'admin', 'studio']).optional(),
      status: z.enum(['active', 'suspended', 'deactivated']).optional(),
    }).safeParse(req.body);

    if (!body.success) return reply.status(400).send({ message: 'Invalid data' });

    const updates: string[] = [];
    const params: unknown[] = [];
    if (body.data.name)   { params.push(body.data.name);   updates.push(`name = $${params.length}`); }
    if (body.data.portal) { params.push(body.data.portal); updates.push(`portal = $${params.length}`); }
    if (body.data.status) { params.push(body.data.status); updates.push(`status = $${params.length}`); }

    if (updates.length) {
      updates.push('updated_at = now()');
      params.push(id);
      await dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    }

    const updated = await dbGet<any>(
      'SELECT u.*, c.name as company_name FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = $1',
      [id]
    );
    return {
      user: {
        id: updated.id, email: updated.email, name: updated.name,
        portal: updated.portal, status: updated.status,
        companyId: updated.company_id ?? undefined,
        companyName: updated.company_name ?? undefined,
      },
    };
  });
};

export default adminRoutes;