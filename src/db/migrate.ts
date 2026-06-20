/**
 * src/db/migrate.ts
 * Runs the Postgres schema (schema.sql) against the connected Neon database.
 * Idempotent — every statement uses IF NOT EXISTS, safe to run on every boot.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbExec } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export async function runMigrations(): Promise<void> {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    await dbExec(schema);
    console.log('✓ Database migrations complete');
}