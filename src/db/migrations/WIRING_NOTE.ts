/**
 * WIRING NOTE — add this to your existing src/db/migrate.ts
 * (not shown to me, so I can't safely rewrite it — just add these two lines)
 *
 *   import { runPilotAndMealWindowMigration } from './migrations/002_pilot_and_meal_windows.js';
 *
 *   export async function runMigrations() {
 *     // ...your existing migration calls...
 *     await runPilotAndMealWindowMigration();
 *   }
 *
 * Run it once against your Neon database — src/index.ts already calls
 * runMigrations() on every server start (via initDb → runMigrations in
 * main()), so simply deploying/restarting with this wired in is enough.
 */
export {};
