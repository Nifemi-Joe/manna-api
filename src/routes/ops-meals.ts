/**
 * src/routes/ops-meals.ts
 * GET    /api/v1/ops/meals
 * POST   /api/v1/ops/meals
 * PATCH  /api/v1/ops/meals/:id
 * POST   /api/v1/ops/meals/:id/image     (multipart upload)
 * DELETE /api/v1/ops/meals/:id           (soft delete — sets available=false)
 *
 * The actual fix for "menu edit UI, not just a seed script" — Ops can
 * now add, edit, retire, and photograph meals directly. The weekly
 * schedule (which meals appear on which day) is still handled by the
 * existing Ops Menus page; this is the meal library those schedules
 * pull from.
 *
 * Registered under /ops (see index.ts), separate from the general
 * ops.ts (deliveries/issues/packing) to avoid touching that file.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import path from 'node:path';
import fs from 'node:fs';
import { dbAll, dbGet, dbRun } from '../db/index.js';

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? './uploads';
const APP_URL = process.env.APP_URL ?? 'http://localhost:3001';

const mealSchema = z.object({
    name: z.string().min(2),
    description: z.string().default(''),
    price: z.number().positive(),
    category: z.enum(['Main', 'Side', 'Drink', 'Snack', 'Protein']).optional(),
    mealWindow: z.enum(['breakfast', 'lunch']),
    spiceLevel: z.enum(['none', 'mild', 'medium', 'hot']).default('none'),
    dietary: z.array(z.string()).default([]),
    allergens: z.array(z.string()).default([]),
});

function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function formatMeal(m: any) {
    return {
        id: m.id,
        name: m.name,
        description: m.description,
        price: m.price,
        mealWindow: m.meal_window,
        spiceLevel: m.spice_level,
        dietary: typeof m.dietary === 'string' ? JSON.parse(m.dietary) : m.dietary,
        allergens: typeof m.allergens === 'string' ? JSON.parse(m.allergens) : m.allergens,
        imageUrl: m.image_url ?? undefined,
        available: m.available === true,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
    };
}

const opsMealsRoutes: FastifyPluginAsync = async (fastify) => {
    // GET /api/v1/ops/meals?window=lunch&includeUnavailable=true
    fastify.get('/meals', async (req) => {
        await req.requirePermission('menus:write');
        const query = req.query as Record<string, string>;

        const conditions: string[] = [];
        const params: unknown[] = [];
        if (query.window) { params.push(query.window); conditions.push(`meal_window = $${params.length}`); }
        if (query.includeUnavailable !== 'true') conditions.push('available = TRUE');

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = await dbAll<any>(`SELECT * FROM meals ${where} ORDER BY meal_window, name`, params);
        return { meals: rows.map(formatMeal) };
    });

    // POST /api/v1/ops/meals — create a new meal
    fastify.post('/meals', async (req, reply) => {
        await req.requirePermission('menus:write');

        const body = mealSchema.safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid meal data', errors: body.error.flatten() });

        let id = slugify(body.data.name);
        const existing = await dbGet('SELECT id FROM meals WHERE id = $1', [id]);
        if (existing) id = `${id}-${nanoid(5)}`;

        await dbRun(
            `INSERT INTO meals (id, name, description, price, spice_level, allergens, dietary, available, meal_window)
             VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)`,
            [id, body.data.name, body.data.description, body.data.price, body.data.spiceLevel, JSON.stringify(body.data.allergens), JSON.stringify(body.data.dietary), body.data.mealWindow]
        );

        const meal = await dbGet<any>('SELECT * FROM meals WHERE id = $1', [id]);
        return reply.status(201).send({ meal: formatMeal(meal) });
    });

    // PATCH /api/v1/ops/meals/:id
    fastify.patch('/meals/:id', async (req, reply) => {
        await req.requirePermission('menus:write');
        const { id } = req.params as { id: string };

        const existing = await dbGet('SELECT id FROM meals WHERE id = $1', [id]);
        if (!existing) return reply.status(404).send({ message: 'Meal not found' });

        const body = mealSchema.partial().safeParse(req.body);
        if (!body.success) return reply.status(400).send({ message: 'Invalid meal data', errors: body.error.flatten() });

        const fieldMap: Record<string, string> = {
            name: 'name', description: 'description', price: 'price',
            mealWindow: 'meal_window', spiceLevel: 'spice_level',
        };
        const jsonFields: Record<string, string> = { dietary: 'dietary', allergens: 'allergens' };

        const updates: string[] = [];
        const params: unknown[] = [];
        for (const [key, column] of Object.entries(fieldMap)) {
            const value = (body.data as any)[key];
            if (value !== undefined) { params.push(value); updates.push(`${column} = $${params.length}`); }
        }
        for (const [key, column] of Object.entries(jsonFields)) {
            const value = (body.data as any)[key];
            if (value !== undefined) { params.push(JSON.stringify(value)); updates.push(`${column} = $${params.length}`); }
        }

        if (updates.length) {
            updates.push('updated_at = now()');
            params.push(id);
            await dbRun(`UPDATE meals SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
        }

        const meal = await dbGet<any>('SELECT * FROM meals WHERE id = $1', [id]);
        return { meal: formatMeal(meal) };
    });

    // POST /api/v1/ops/meals/:id/image — multipart image upload
    fastify.post('/meals/:id/image', async (req, reply) => {
        await req.requirePermission('menus:write');
        const { id } = req.params as { id: string };

        const meal = await dbGet('SELECT id FROM meals WHERE id = $1', [id]);
        if (!meal) return reply.status(404).send({ message: 'Meal not found' });

        const file = await req.file();
        if (!file) return reply.status(400).send({ message: 'No file uploaded' });

        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(file.mimetype)) {
            return reply.status(400).send({ message: 'Only JPEG, PNG, or WebP images are allowed' });
        }

        if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

        const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
        const filename = `meal-${id}-${nanoid(8)}.${ext}`;
        const filepath = path.join(UPLOADS_DIR, filename);

        await new Promise<void>((resolve, reject) => {
            const writeStream = fs.createWriteStream(filepath);
            file.file.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        const imageUrl = `${APP_URL}/uploads/${filename}`;
        await dbRun('UPDATE meals SET image_url = $1, updated_at = now() WHERE id = $2', [imageUrl, id]);

        const updated = await dbGet<any>('SELECT * FROM meals WHERE id = $1', [id]);
        return { meal: formatMeal(updated) };
    });

    // DELETE /api/v1/ops/meals/:id — soft delete (orders reference meal_id, never hard-delete)
    fastify.delete('/meals/:id', async (req, reply) => {
        await req.requirePermission('menus:write');
        const { id } = req.params as { id: string };

        const meal = await dbGet('SELECT id FROM meals WHERE id = $1', [id]);
        if (!meal) return reply.status(404).send({ message: 'Meal not found' });

        await dbRun(`UPDATE meals SET available = FALSE, updated_at = now() WHERE id = $1`, [id]);
        return { success: true };
    });
};

export default opsMealsRoutes;
