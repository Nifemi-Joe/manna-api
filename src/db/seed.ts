/**
 * src/db/seed.ts
 * Seeds development data. Safe to re-run (checks existence first).
 */

import 'dotenv/config';
import { initDb, dbGet, dbRun, dbAll, persistDb, dbExec } from './index.js';
import { runMigrations } from './migrate.js';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';

function now() { return new Date().toISOString(); }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }
function weekStart() {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0,0,0,0);
    return d.toISOString().slice(0,10);
}
function dateOfWeek(offset: number) {
    const d = new Date(weekStart());
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0,10);
}

async function seed() {
    await initDb();
    runMigrations();

    // ── Permissions ──────────────────────────────────────────
    const PERMS: Array<{ key: string; label: string; grp: string }> = [
        { key: 'orders:read',       label: 'View orders',          grp: 'Orders' },
        { key: 'orders:create',     label: 'Place orders',         grp: 'Orders' },
        { key: 'orders:cancel',     label: 'Cancel own orders',    grp: 'Orders' },
        { key: 'orders:cancel_any', label: 'Cancel any order',     grp: 'Orders' },
        { key: 'employees:read',    label: 'View employees',       grp: 'HR' },
        { key: 'employees:write',   label: 'Add/edit employees',   grp: 'HR' },
        { key: 'employees:delete',  label: 'Remove employees',     grp: 'HR' },
        { key: 'rules:read',        label: 'View rules',           grp: 'HR' },
        { key: 'rules:write',       label: 'Edit rules',           grp: 'HR' },
        { key: 'billing:read',      label: 'View billing',         grp: 'HR' },
        { key: 'reports:read',      label: 'View reports',         grp: 'HR' },
        { key: 'deliveries:read',   label: 'View deliveries',      grp: 'Ops' },
        { key: 'deliveries:update', label: 'Update delivery status', grp: 'Ops' },
        { key: 'issues:read',       label: 'View issues',          grp: 'Ops' },
        { key: 'issues:write',      label: 'Manage issues',        grp: 'Ops' },
        { key: 'menus:read',        label: 'View menus',           grp: 'Ops' },
        { key: 'menus:write',       label: 'Edit menus',           grp: 'Ops' },
        { key: 'menus:publish',     label: 'Publish menus',        grp: 'Ops' },
        { key: 'companies:read',    label: 'View companies',       grp: 'Admin' },
        { key: 'companies:write',   label: 'Edit companies',       grp: 'Admin' },
        { key: 'users:read',        label: 'View users',           grp: 'Admin' },
        { key: 'users:write',       label: 'Edit users',           grp: 'Admin' },
        { key: 'users:suspend',     label: 'Suspend users',        grp: 'Admin' },
        { key: 'roles:read',        label: 'View roles',           grp: 'RBAC' },
        { key: 'roles:write',       label: 'Manage roles',         grp: 'RBAC' },
        { key: 'assignments:read',  label: 'View assignments',     grp: 'RBAC' },
        { key: 'assignments:write', label: 'Manage assignments',   grp: 'RBAC' },
        { key: 'content:read',      label: 'View content',         grp: 'Content' },
        { key: 'content:write',     label: 'Edit content',         grp: 'Content' },
        { key: 'content:publish',   label: 'Publish content',      grp: 'Content' },
        { key: 'media:read',        label: 'View media',           grp: 'Content' },
        { key: 'media:write',       label: 'Upload/edit media',    grp: 'Content' },
    ];

    for (const p of PERMS) {
        const exists = dbGet('SELECT id FROM permissions WHERE key = ?', [p.key]);
        if (!exists) {
            dbRun(
                'INSERT INTO permissions (id, key, label, grp) VALUES (?, ?, ?, ?)',
                [nanoid(), p.key, p.label, p.grp]
            );
        }
    }
    console.log('  ✓ Permissions seeded');

    // ── Companies ────────────────────────────────────────────
    const existingCo = dbGet('SELECT id FROM companies WHERE slug = ?', ['techcorp-ng']);
    let coId = (existingCo as any)?.id;
    if (!coId) {
        coId = nanoid();
        dbRun(
            `INSERT INTO companies (id, name, slug, plan, status, address, city, employees_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [coId, 'TechCorp Nigeria', 'techcorp-ng', 'growth', 'active',
                '14 Kofo Abayomi St, Victoria Island', 'Lagos', 24]
        );
    }

    let co2Id = (dbGet('SELECT id FROM companies WHERE slug = ?', ['fintech-lagos']) as any)?.id;
    if (!co2Id) {
        co2Id = nanoid();
        dbRun(
            `INSERT INTO companies (id, name, slug, plan, status, address, city, employees_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [co2Id, 'FinTech Lagos', 'fintech-lagos', 'starter', 'active',
                '7 Adeola Odeku, Victoria Island', 'Lagos', 11]
        );
    }
    console.log('  ✓ Companies seeded');

    // ── Users ────────────────────────────────────────────────
    const USERS = [
        // Admin / Ops / Studio (no company)
        { id: 'u-admin-1', email: 'admin@mannaworkmeals.com',     name: 'Chidi Okeke',     portal: 'admin',    companyId: null },
        { id: 'u-ops-1',   email: 'ops@mannaworkmeals.com',       name: 'Emeka Nwosu',     portal: 'ops',      companyId: null },
        { id: 'u-studio-1',email: 'content@mannaworkmeals.com',   name: 'Amara Okafor',    portal: 'studio',   companyId: null },
        // HR users per company
        { id: 'u-hr-1',    email: 'hr@techcorp.ng',               name: 'Ngozi Adeyemi',   portal: 'hr',       companyId: coId },
        { id: 'u-hr-2',    email: 'hr@fintechlagos.com',          name: 'Kelechi Eze',     portal: 'hr',       companyId: co2Id },
        // Employees TechCorp
        { id: 'u-emp-1',   email: 'tunde.afolabi@techcorp.ng',    name: 'Tunde Afolabi',   portal: 'employee', companyId: coId },
        { id: 'u-emp-2',   email: 'adaeze.okonkwo@techcorp.ng',   name: 'Adaeze Okonkwo',  portal: 'employee', companyId: coId },
        { id: 'u-emp-3',   email: 'seun.bello@techcorp.ng',       name: 'Seun Bello',      portal: 'employee', companyId: coId },
        { id: 'u-emp-4',   email: 'yemi.johnson@techcorp.ng',     name: 'Yemi Johnson',    portal: 'employee', companyId: coId },
        // Employees FinTech
        { id: 'u-emp-5',   email: 'damilola.taiwo@fintechlagos.com', name: 'Damilola Taiwo', portal: 'employee', companyId: co2Id },
        { id: 'u-emp-6',   email: 'ibrahim.musa@fintechlagos.com',   name: 'Ibrahim Musa',   portal: 'employee', companyId: co2Id },
    ];

    for (const u of USERS) {
        const exists = dbGet('SELECT id FROM users WHERE id = ?', [u.id]);
        if (!exists) {
            dbRun(
                `INSERT INTO users (id, email, name, portal, company_id, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
                [u.id, u.email, u.name, u.portal, u.companyId]
            );
        }
    }
    console.log('  ✓ Users seeded');

    // ── Allowance rules ──────────────────────────────────────
    for (const [cId, dailyAmt] of [[coId, 3000], [co2Id, 2500]]) {
        const exists = dbGet('SELECT id FROM allowance_rules WHERE company_id = ?', [cId]);
        if (!exists) {
            dbRun(
                `INSERT INTO allowance_rules (id, company_id, daily_amount, monthly_cap_enabled, meal_type, allow_top_ups, max_top_up, max_meals_per_day)
         VALUES (?, ?, ?, 0, 'lunch', 1, 5000, 1)`,
                [nanoid(), cId, dailyAmt]
            );
        }
    }
    console.log('  ✓ Allowance rules seeded');

    // ── System roles ─────────────────────────────────────────
    const SYSTEM_ROLES = [
        { id: 'role-admin',   name: 'Super Admin',  perms: PERMS.map(p => p.key) },
        { id: 'role-hr',      name: 'HR Manager',   perms: ['orders:read','employees:read','employees:write','rules:read','rules:write','billing:read','reports:read','roles:read','assignments:read'] },
        { id: 'role-ops',     name: 'Ops Lead',     perms: ['deliveries:read','deliveries:update','issues:read','issues:write','menus:read','menus:write','menus:publish','orders:read'] },
        { id: 'role-employee',name: 'Employee',     perms: ['orders:read','orders:create','orders:cancel'] },
        { id: 'role-studio',  name: 'Content Editor',perms: ['content:read','content:write','content:publish','media:read','media:write'] },
    ];

    for (const r of SYSTEM_ROLES) {
        const exists = dbGet('SELECT id FROM roles WHERE id = ?', [r.id]);
        if (!exists) {
            dbRun(
                `INSERT INTO roles (id, name, scope, company_id) VALUES (?, ?, 'system', NULL)`,
                [r.id, r.name]
            );
            for (const pk of r.perms) {
                const perm = dbGet<{id:string}>('SELECT id FROM permissions WHERE key = ?', [pk]);
                if (perm) {
                    dbRun('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [r.id, perm.id]);
                }
            }
        }
    }
    console.log('  ✓ System roles seeded');

    // Assign roles to users
    const ASSIGNMENTS = [
        { uid: 'u-admin-1', rid: 'role-admin' },
        { uid: 'u-ops-1',   rid: 'role-ops' },
        { uid: 'u-studio-1',rid: 'role-studio' },
        { uid: 'u-hr-1',    rid: 'role-hr' },
        { uid: 'u-hr-2',    rid: 'role-hr' },
        { uid: 'u-emp-1',   rid: 'role-employee' },
        { uid: 'u-emp-2',   rid: 'role-employee' },
        { uid: 'u-emp-3',   rid: 'role-employee' },
        { uid: 'u-emp-4',   rid: 'role-employee' },
        { uid: 'u-emp-5',   rid: 'role-employee' },
        { uid: 'u-emp-6',   rid: 'role-employee' },
    ];
    for (const a of ASSIGNMENTS) {
        const exists = dbGet('SELECT id FROM role_assignments WHERE user_id = ? AND role_id = ?', [a.uid, a.rid]);
        if (!exists) {
            dbRun(
                `INSERT INTO role_assignments (id, user_id, role_id, assigned_by, status)
         VALUES (?, ?, ?, 'system', 'active')`,
                [nanoid(), a.uid, a.rid]
            );
        }
    }
    console.log('  ✓ Role assignments seeded');

    // ── Meals ────────────────────────────────────────────────
    const MEALS = [
        { id: 'm-jollof',    name: 'Jollof Rice & Chicken',     description: 'Smoky party-style jollof with grilled chicken thigh, plantain, and coleslaw.', price: 2800, spice: 'medium', allergens: '[]', dietary: '[{"id":"d1","label":"halal"}]' },
        { id: 'm-egusi',     name: 'Egusi Soup & Pounded Yam',  description: 'Rich melon seed soup with assorted meats and stock fish.', price: 3200, spice: 'mild', allergens: '[{"id":"a1","label":"shellfish"}]', dietary: '[{"id":"d1","label":"halal"}]' },
        { id: 'm-moimoi',    name: 'Moi Moi & Ogi',             description: 'Steamed bean pudding with golden corn porridge.', price: 1800, spice: 'none', allergens: '[]', dietary: '[{"id":"d2","label":"vegan"},{"id":"d1","label":"halal"},{"id":"d3","label":"spice-free"}]' },
        { id: 'm-ofada',     name: 'Ofada Rice & Ayamase',      description: 'Local unpolished rice with spicy green pepper sauce.', price: 3000, spice: 'hot', allergens: '[]', dietary: '[{"id":"d1","label":"halal"}]' },
        { id: 'm-pasta',     name: 'Pasta Bolognese',            description: 'Penne pasta in slow-cooked beef tomato sauce with parmesan.', price: 2500, spice: 'none', allergens: '[{"id":"a2","label":"gluten"},{"id":"a3","label":"dairy"}]', dietary: '[{"id":"d3","label":"spice-free"}]' },
        { id: 'm-tilapia',   name: 'Grilled Tilapia & Chips',   description: 'Whole tilapia seasoned with peppers and herbs, served with fries.', price: 3500, spice: 'mild', allergens: '[{"id":"a4","label":"fish"}]', dietary: '[{"id":"d1","label":"halal"},{"id":"d4","label":"gluten-free"}]' },
        { id: 'm-pepper',    name: 'Catfish Pepper Soup',        description: 'Spiced catfish pepper soup with chilled corn meal.', price: 3200, spice: 'hot', allergens: '[{"id":"a4","label":"fish"}]', dietary: '[{"id":"d1","label":"halal"},{"id":"d4","label":"gluten-free"}]' },
        { id: 'm-friedrice', name: 'Fried Rice & Turkey',        description: 'Nigerian-style fried rice loaded with vegetables.', price: 2800, spice: 'mild', allergens: '[]', dietary: '[{"id":"d1","label":"halal"}]' },
        { id: 'm-efo',       name: 'Efo Riro & Eba',            description: 'Yoruba spinach stew with assorted meats, served with garri.', price: 2600, spice: 'medium', allergens: '[]', dietary: '[{"id":"d1","label":"halal"}]' },
        { id: 'm-beans',     name: 'Beans & Plantain',           description: 'Ewa agoyin with soft boiled beans and sweet fried plantain.', price: 1800, spice: 'medium', allergens: '[]', dietary: '[{"id":"d2","label":"vegan"},{"id":"d1","label":"halal"},{"id":"d4","label":"gluten-free"}]' },
        { id: 'm-suya',      name: 'Suya Platter',               description: 'Skewered grilled beef suya with onions and yaji spice blend.', price: 3800, spice: 'hot', allergens: '[{"id":"a5","label":"groundnut"}]', dietary: '[{"id":"d1","label":"halal"},{"id":"d4","label":"gluten-free"}]' },
        { id: 'm-coconut',   name: 'Coconut Rice & Chicken',     description: 'Fragrant long grain rice cooked in coconut milk.', price: 3000, spice: 'none', allergens: '[]', dietary: '[{"id":"d1","label":"halal"},{"id":"d4","label":"gluten-free"},{"id":"d3","label":"spice-free"}]' },
        { id: 'm-oha',       name: 'Pounded Yam & Oha Soup',    description: 'Silky pounded yam with Igbo oha leaf soup.', price: 3400, spice: 'mild', allergens: '[]', dietary: '[{"id":"d1","label":"halal"},{"id":"d4","label":"gluten-free"}]' },
        { id: 'm-abacha',    name: 'Abacha & Ugba',              description: 'African salad with palm oil, ugba, garden eggs and ukpaka.', price: 2200, spice: 'medium', allergens: '[]', dietary: '[{"id":"d2","label":"vegan"},{"id":"d1","label":"halal"},{"id":"d4","label":"gluten-free"}]' },
        { id: 'm-shawarma',  name: 'Chicken Shawarma Wrap',       description: 'Juicy grilled chicken with garlic sauce in a flour wrap.', price: 2800, spice: 'mild', allergens: '[{"id":"a2","label":"gluten"}]', dietary: '[{"id":"d1","label":"halal"}]' },
        { id: 'm-tofu',      name: 'Tofu Stir Fry & Rice',       description: 'Pan-fried tofu with bok choy and ginger soy sauce.', price: 2400, spice: 'mild', allergens: '[{"id":"a6","label":"soy"}]', dietary: '[{"id":"d2","label":"vegan"},{"id":"d4","label":"gluten-free"}]' },
    ];

    for (const m of MEALS) {
        const exists = dbGet('SELECT id FROM meals WHERE id = ?', [m.id]);
        if (!exists) {
            dbRun(
                `INSERT INTO meals (id, name, description, price, spice_level, allergens, dietary, available)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                [m.id, m.name, m.description, m.price, m.spice, m.allergens, m.dietary]
            );
        }
    }
    console.log('  ✓ Meals seeded');

    // ── This week's menu ─────────────────────────────────────
    const ws = weekStart();
    const existingMenu = dbGet('SELECT id FROM menus WHERE week_start = ?', [ws]);
    let menuId = (existingMenu as any)?.id;
    if (!menuId) {
        menuId = nanoid();
        dbRun(
            `INSERT INTO menus (id, week_start, published, published_at, created_by)
       VALUES (?, ?, 1, ?, 'system')`,
            [menuId, ws, now()]
        );

        // Daily meal assignments (5 meals per day Mon-Fri)
        const DAILY_MEALS: Record<number, string[]> = {
            0: ['m-jollof',   'm-egusi',    'm-moimoi',  'm-ofada',   'm-pasta',    'm-tilapia'],
            1: ['m-pepper',   'm-friedrice','m-beans',   'm-oha',     'm-shawarma', 'm-tofu'],
            2: ['m-efo',      'm-jollof',   'm-coconut', 'm-moimoi',  'm-pasta',    'm-tilapia'],
            3: ['m-egusi',    'm-friedrice','m-suya',    'm-abacha',  'm-shawarma', 'm-tofu'],
            4: ['m-suya',     'm-oha',      'm-coconut','m-abacha',  'm-beans',    'm-jollof'],
        };

        for (let dayOffset = 0; dayOffset < 5; dayOffset++) {
            const date = dateOfWeek(dayOffset);
            const cutoff = `${date}T10:00:00.000Z`;
            for (const mId of DAILY_MEALS[dayOffset]) {
                dbRun(
                    `INSERT OR IGNORE INTO menu_meals (id, menu_id, date, meal_id, cutoff_time)
           VALUES (?, ?, ?, ?, ?)`,
                    [nanoid(), menuId, date, mId, cutoff]
                );
            }
        }
    }
    console.log('  ✓ Weekly menu seeded');

    // ── Sample orders (last 7 days) ───────────────────────────
    const orderedMeals = [
        { userId: 'u-emp-1', mealId: 'm-jollof',    mealName: 'Jollof Rice & Chicken', price: 2800, status: 'delivered' },
        { userId: 'u-emp-2', mealId: 'm-egusi',      mealName: 'Egusi Soup & Pounded Yam', price: 3200, status: 'delivered' },
        { userId: 'u-emp-3', mealId: 'm-efo',        mealName: 'Efo Riro & Eba', price: 2600, status: 'delivered' },
        { userId: 'u-emp-1', mealId: 'm-friedrice',  mealName: 'Fried Rice & Turkey', price: 2800, status: 'delivered' },
        { userId: 'u-emp-4', mealId: 'm-suya',       mealName: 'Suya Platter', price: 3800, status: 'delivered' },
        { userId: 'u-emp-2', mealId: 'm-pasta',      mealName: 'Pasta Bolognese', price: 2500, status: 'delivered' },
        { userId: 'u-emp-5', mealId: 'm-jollof',     mealName: 'Jollof Rice & Chicken', price: 2800, status: 'delivered' },
        { userId: 'u-emp-6', mealId: 'm-coconut',    mealName: 'Coconut Rice & Chicken', price: 3000, status: 'delivered' },
        { userId: 'u-emp-1', mealId: 'm-oha',        mealName: 'Pounded Yam & Oha Soup', price: 3400, status: 'confirmed' },
        { userId: 'u-emp-3', mealId: 'm-shawarma',   mealName: 'Chicken Shawarma Wrap', price: 2800, status: 'confirmed' },
    ];

    for (let i = 0; i < orderedMeals.length; i++) {
        const m = orderedMeals[i];
        const daysBack = Math.floor(i / 2) + 1;
        const d = new Date(); d.setDate(d.getDate() - daysBack);
        const date = d.toISOString().slice(0,10);
        const existing = dbGet('SELECT id FROM orders WHERE user_id = ? AND meal_id = ? AND date = ?', [m.userId, m.mealId, date]);
        if (!existing) {
            const companyId = ['u-emp-1','u-emp-2','u-emp-3','u-emp-4'].includes(m.userId) ? coId : co2Id;
            const allowanceCovered = Math.min(m.price, 3000);
            const empPaid = Math.max(0, m.price - allowanceCovered);
            const orderId = nanoid();
            dbRun(
                `INSERT INTO orders (id, user_id, company_id, meal_id, meal_name, date, status, total_amount, allowance_covered, employee_paid, delivery_address, cancellable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
                [orderId, m.userId, companyId, m.mealId, m.mealName, date, m.status, m.price, allowanceCovered, empPaid, '14 Kofo Abayomi St, Victoria Island, Lagos']
            );

            // Create delivery
            dbRun(
                `INSERT INTO deliveries (id, order_id, company_id, status, delivery_address, scheduled_for)
         VALUES (?, ?, ?, ?, ?, ?)`,
                [nanoid(), orderId, companyId, m.status === 'delivered' ? 'delivered' : 'scheduled',
                    '14 Kofo Abayomi St, Victoria Island, Lagos',
                    `${date}T12:30:00.000Z`]
            );
        }
    }
    console.log('  ✓ Sample orders seeded');

    // ── Content entries ──────────────────────────────────────
    const CONTENT: Array<{ key: string; type: string; title: string; section: string; content: string; status: string }> = [
        { key: 'landing/hero', type: 'markdown', title: 'Hero Section', section: 'landing', status: 'published',
            content: '# Office meals, finally under control.\n\nManna handles daily lunch for your team — HR sets the budget, employees order from a fresh menu, and we deliver. Simple.' },
        { key: 'landing/cta', type: 'markdown', title: 'CTA Section', section: 'landing', status: 'published',
            content: '## Ready to transform your office meals?\n\nJoin pilot companies across Lagos Island and Victoria Island.' },
        { key: 'landing/benefits', type: 'markdown', title: 'Benefits Grid', section: 'landing', status: 'draft',
            content: '## Why Manna?\n\n- **No logistics stress** — we handle everything\n- **Budget control** — set allowances per employee\n- **Fresh daily menus** — real Nigerian food' },
        { key: 'faq/hr', type: 'json', title: 'HR FAQs', section: 'faq', status: 'published',
            content: JSON.stringify([
                { q: 'How do I get started?', a: 'Request a pilot via the landing page.' },
                { q: 'How does billing work?', a: 'Monthly invoice, due within 7 days.' },
            ]) },
        { key: 'email/welcome', type: 'text', title: 'Welcome Email', section: 'email', status: 'draft',
            content: 'Welcome to Manna! Your daily lunch benefit is now active.' },
    ];

    for (const c of CONTENT) {
        const exists = dbGet('SELECT key FROM content_entries WHERE key = ?', [c.key]);
        if (!exists) {
            dbRun(
                `INSERT INTO content_entries (key, type, title, status, section, content, edited_by, last_published_at)
         VALUES (?, ?, ?, ?, ?, ?, 'system', ?)`,
                [c.key, c.type, c.title, c.status, c.section, c.content,
                    c.status === 'published' ? daysAgo(10) : null]
            );
        }
    }
    console.log('  ✓ Content entries seeded');

    // ── Issues ───────────────────────────────────────────────
    const ISSUES = [
        { title: 'Missing meal — Jollof delivery', description: 'Employee reported meal was missing from delivery bag.', severity: 'high', status: 'open', companyId: coId },
        { title: 'Late delivery — VI office', description: 'Delivery arrived at 2:45 PM, 75 minutes past SLA.', severity: 'medium', status: 'resolved', companyId: coId },
        { title: 'Wrong meal — Pasta instead of Ofada', description: 'Employee received pasta instead of ordered Ofada Rice.', severity: 'medium', status: 'open', companyId: co2Id },
    ];
    for (const iss of ISSUES) {
        const exists = dbGet('SELECT id FROM issues WHERE title = ?', [iss.title]);
        if (!exists) {
            dbRun(
                `INSERT INTO issues (id, company_id, title, description, severity, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
                [nanoid(), iss.companyId, iss.title, iss.description, iss.severity, iss.status]
            );
        }
    }
    console.log('  ✓ Issues seeded');

    persistDb();
    console.log('\n✅ Seed complete.');
}

seed().catch(e => { console.error(e); process.exit(1); });