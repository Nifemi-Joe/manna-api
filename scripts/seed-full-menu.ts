/**
 * scripts/seed-full-menu.ts
 *
 * Same as before, PLUS: every meal now carries an `imageUrl` pointing
 * at /images/menu/{id}.jpg — matching the exact filenames given to you
 * in chat. Download each Drive file, rename it to the filename in that
 * table, and drop all 34 into public/images/menu/ in your FRONTEND
 * repo (not this backend repo). The path is relative
 * (`/images/menu/...`), which works because meal images are only ever
 * rendered inside the Next.js frontend — the backend just stores and
 * returns the string, it never serves the file itself.
 *
 * If a file is missing for a given id, the frontend's MealCard falls
 * back to the gradient+emoji placeholder automatically (see the updated
 * employee/menu/page.tsx) — nothing breaks, it just won't have a real
 * photo until you add one.
 *
 * Usage: npm run seed-full-menu
 */

import 'dotenv/config';
import { initDb, dbGet, dbRun, closeDb } from '../src/db/index.js';
import { nanoid } from 'nanoid';

type Category = 'Main' | 'Side' | 'Drink' | 'Snack' | 'Protein';
type Window = 'breakfast' | 'lunch';

interface RawMeal {
    id: string;
    name: string;
    description: string;
    category: Category;
    price: number;
}

const MEALS: RawMeal[] = [
    { id: 'jollof-fried-rice-chicken-plantain', name: 'Jollof/Fried Rice + Chicken + Plantain', description: 'Long grain rice, tomatoes, pepper, onions, seasoning, grilled/fried chicken, fried plantain', category: 'Main', price: 3000 },
    { id: 'jollof-fried-rice-beef-plantain', name: 'Jollof/Fried Rice + Beef + Plantain', description: 'Long grain rice, tomatoes, pepper, onions, seasoning, beef, fried plantain', category: 'Main', price: 2500 },
    { id: 'jollof-fried-rice-turkey-plantain', name: 'Jollof/Fried Rice + Turkey + Plantain', description: 'Long grain rice, tomatoes, pepper, onions, seasoning, turkey, fried plantain', category: 'Main', price: 4500 },
    { id: 'spaghetti-chicken', name: 'Stir-fry/Jollof Spaghetti + Chicken', description: 'Spaghetti, mixed vegetables, soy sauce, pepper, onions, chicken', category: 'Main', price: 3000 },
    { id: 'spaghetti-beef', name: 'Stir-fry/Jollof Spaghetti + Beef', description: 'Spaghetti, mixed vegetables, soy sauce, pepper, onions, beef', category: 'Main', price: 3000 },
    { id: 'spaghetti-turkey', name: 'Stir-fry/Jollof Spaghetti + Turkey', description: 'Spaghetti, mixed vegetables, soy sauce, pepper, onions, turkey', category: 'Main', price: 4500 },
    { id: 'ofada-rice-sauce-egg', name: 'Ofada Rice + Ofada Sauce + Egg', description: 'Ofada rice, palm oil sauce, iru, assorted meat, boiled egg', category: 'Main', price: 3500 },
    { id: 'yam-porridge-beef', name: 'Yam Porridge + Beef', description: 'Yam, palm oil, pepper, onions, seasoning, beef', category: 'Main', price: 2500 },
    { id: 'swallow-egusi-efo-ogbono', name: 'Swallow & Egusi / Efo Riro / Ogbono', description: 'Swallow (eba/poundo), egusi/efo/ogbono soup, assorted meat', category: 'Main', price: 3000 },
    { id: 'swallow-edikaikong', name: 'Swallow & Edikaikong', description: 'Swallow, edikaikong soup, vegetables, assorted meat', category: 'Main', price: 3500 },
    { id: 'yamarita-egg-sauce', name: 'Yamarita + Egg Sauce', description: 'Fried yam, egg sauce, pepper, onions', category: 'Main', price: 3000 },
    { id: 'white-rice-buka-stew-plantain', name: 'White Rice + Buka Stew + Plantain', description: 'White rice, buka stew, assorted meat, fried plantain', category: 'Main', price: 2500 },
    { id: 'moi-moi', name: 'Moi Moi', description: 'Beans paste, pepper, onions, oil, seasoning', category: 'Side', price: 600 },
    { id: 'coleslaw', name: 'Coleslaw', description: 'Cabbage, carrots, mayonnaise', category: 'Side', price: 500 },
    { id: 'juiceup-pineapple-ginger', name: 'JuiceUp Pineapple & Ginger', description: 'Fresh pineapple, ginger', category: 'Drink', price: 2500 },
    { id: 'juiceup-pineapple-watermelon', name: 'JuiceUp Pineapple & Watermelon', description: 'Pineapple, watermelon', category: 'Drink', price: 2500 },
    { id: 'juiceup-zobo', name: 'JuiceUp Zobo', description: 'Hibiscus leaves, pineapple, ginger, cloves', category: 'Drink', price: 2200 },
    { id: 'juiceup-tigernut', name: 'JuiceUp Tigernut', description: 'Tiger nuts, dates, coconut', category: 'Drink', price: 2500 },
    { id: 'juiceup-pineapple', name: 'JuiceUp Pineapple', description: 'Fresh pineapple juice', category: 'Drink', price: 2500 },
    { id: 'mini-banana-bread', name: 'Mini Banana Bread', description: 'Banana, flour, eggs, sugar, butter', category: 'Snack', price: 1000 },
    { id: 'big-banana-loaf', name: 'Big Banana Loaf', description: 'Banana, flour, eggs, sugar, butter', category: 'Snack', price: 3000 },
    { id: 'chicken-sandwich', name: 'Chicken Sandwich', description: 'Bread, chicken, lettuce, mayo', category: 'Snack', price: 3100 },
    { id: 'sausage-roll', name: 'Sausage Roll', description: 'Pastry, sausage filling', category: 'Snack', price: 800 },
    { id: 'chicken-pie', name: 'Chicken Pie', description: 'Pastry, chicken filling', category: 'Snack', price: 1000 },
    { id: 'meat-pie', name: 'Meat Pie', description: 'Pastry, beef filling', category: 'Snack', price: 1000 },
    { id: 'chicken-protein', name: 'Chicken', description: 'Grilled/fried chicken', category: 'Protein', price: 1200 },
    { id: 'turkey-protein', name: 'Turkey', description: 'Grilled/fried turkey', category: 'Protein', price: 2900 },
    { id: 'beef-protein', name: 'Beef', description: 'Fried beef', category: 'Protein', price: 500 },
    { id: 'chicken-wrap', name: 'Chicken Wrap', description: 'Wrap, chicken, veggies, sauce', category: 'Snack', price: 3500 },
    { id: 'skillet', name: 'Skillet', description: "Chef's daily skillet special", category: 'Main', price: 4000 },
    { id: 'hake-fish', name: 'Hake Fish', description: 'Grilled/fried hake fish', category: 'Protein', price: 800 },
    { id: 'doughnut-jam', name: 'Doughnut (Jam Filling)', description: 'Fried doughnut with jam filling', category: 'Snack', price: 1000 },
    { id: 'doughnut-chocolate', name: 'Doughnut (Chocolate Filling)', description: 'Fried doughnut with chocolate filling', category: 'Snack', price: 1000 },
    { id: 'oat-cookies', name: 'Oat Cookies', description: 'Flour, oat powder, butter, sugar, egg', category: 'Snack', price: 1000 },
    { id: 'chocolate-cookies', name: 'Chocolate Cookies', description: 'Flour, cocoa powder, butter, sugar, egg, chocolate chips', category: 'Snack', price: 1000 },
    { id: 'parfait', name: 'Parfait', description: 'Parfait yogurt, granola, fruit', category: 'Snack', price: 2500 },
];

/** Every id maps to /images/menu/{id}.jpg — matches the filename table given in chat. */
function imageUrlFor(id: string): string {
    return `/images/menu/${id}.jpg`;
}

function windowForCategory(cat: Category): Window {
    return cat === 'Snack' || cat === 'Drink' ? 'breakfast' : 'lunch';
}

function weekStart(): string {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
}

function dateOfWeek(offset: number): string {
    const d = new Date(weekStart());
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
}

const LUNCH_MAINS_BY_DAY: string[][] = [
    ['jollof-fried-rice-chicken-plantain', 'ofada-rice-sauce-egg', 'swallow-egusi-efo-ogbono', 'white-rice-buka-stew-plantain'],
    ['spaghetti-chicken', 'yam-porridge-beef', 'swallow-edikaikong', 'jollof-fried-rice-beef-plantain'],
    ['yamarita-egg-sauce', 'jollof-fried-rice-turkey-plantain', 'spaghetti-beef', 'skillet'],
    ['swallow-egusi-efo-ogbono', 'white-rice-buka-stew-plantain', 'spaghetti-turkey', 'ofada-rice-sauce-egg'],
    ['skillet', 'jollof-fried-rice-chicken-plantain', 'yam-porridge-beef', 'swallow-edikaikong'],
];
const LUNCH_SIDES_EVERY_DAY = ['moi-moi', 'coleslaw', 'chicken-protein', 'beef-protein', 'hake-fish', 'turkey-protein'];
const BREAKFAST_EVERY_DAY = MEALS.filter((m) => windowForCategory(m.category) === 'breakfast').map((m) => m.id);

const BREAKFAST_CUTOFF_HOUR = 12;
const LUNCH_CUTOFF_HOUR = 16;

async function seed() {
    await initDb();

    for (const m of MEALS) {
        const exists = await dbGet('SELECT id FROM meals WHERE id = $1', [m.id]);
        const window = windowForCategory(m.category);
        const imageUrl = imageUrlFor(m.id);
        if (!exists) {
            await dbRun(
                `INSERT INTO meals (id, name, description, price, spice_level, allergens, dietary, available, meal_window, image_url)
                 VALUES ($1, $2, $3, $4, 'none', '[]', '[]', TRUE, $5, $6)`,
                [m.id, m.name, m.description, m.price, window, imageUrl]
            );
        } else {
            await dbRun(
                `UPDATE meals SET name = $2, description = $3, price = $4, meal_window = $5, image_url = $6, available = TRUE, updated_at = now() WHERE id = $1`,
                [m.id, m.name, m.description, m.price, window, imageUrl]
            );
        }
    }
    console.log(`✓ Imported/updated ${MEALS.length} meals (each with an /images/menu/*.jpg imageUrl)`);

    const ws = weekStart();
    let menu = await dbGet<any>('SELECT id FROM menus WHERE week_start = $1', [ws]);
    let menuId = menu?.id;
    if (!menuId) {
        menuId = nanoid();
        await dbRun(
            `INSERT INTO menus (id, week_start, published, published_at, created_by) VALUES ($1, $2, TRUE, now(), 'seed-script')`,
            [menuId, ws]
        );
    } else {
        await dbRun(`UPDATE menus SET published = TRUE, published_at = now(), updated_at = now() WHERE id = $1`, [menuId]);
    }

    for (let dayOffset = 0; dayOffset < 5; dayOffset++) {
        const date = dateOfWeek(dayOffset);

        const breakfastCutoff = `${date}T${String(BREAKFAST_CUTOFF_HOUR).padStart(2, '0')}:00:00.000Z`;
        for (const mealId of BREAKFAST_EVERY_DAY) {
            await dbRun(
                `INSERT INTO menu_meals (id, menu_id, date, meal_id, cutoff_time, meal_window)
                 VALUES ($1, $2, $3, $4, $5, 'breakfast')
                     ON CONFLICT (menu_id, date, meal_id) DO UPDATE SET cutoff_time = $5, meal_window = 'breakfast'`,
                [nanoid(), menuId, date, mealId, breakfastCutoff]
            );
        }

        const lunchCutoff = `${date}T${String(LUNCH_CUTOFF_HOUR).padStart(2, '0')}:00:00.000Z`;
        const lunchMeals = [...LUNCH_MAINS_BY_DAY[dayOffset], ...LUNCH_SIDES_EVERY_DAY];
        for (const mealId of lunchMeals) {
            await dbRun(
                `INSERT INTO menu_meals (id, menu_id, date, meal_id, cutoff_time, meal_window)
                 VALUES ($1, $2, $3, $4, $5, 'lunch')
                     ON CONFLICT (menu_id, date, meal_id) DO UPDATE SET cutoff_time = $5, meal_window = 'lunch'`,
                [nanoid(), menuId, date, mealId, lunchCutoff]
            );
        }

        console.log(`  ✓ ${date}: ${BREAKFAST_EVERY_DAY.length} breakfast items, ${lunchMeals.length} lunch items`);
    }

    console.log(`\n✅ Full week (${ws} → ${dateOfWeek(4)}) published with real menu data and image paths.`);
    await closeDb();
}

seed()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });