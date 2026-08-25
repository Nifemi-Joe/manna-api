/**
 * src/db/migrate.ts
 * Runs every schema file in order against the connected database.
 * Idempotent — safe to run on every boot.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbExec } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_FILES = [
    'schema.sql',
    'schema_v2_pilot.sql',
    'schema_v3_levels.sql',
    'schema_v4_ops.sql',
    'schema_v5_cart.sql',
    'schema_v6_notifications.sql',
    'schema_v7_lead_phone.sql',
];

export async function runMigrations(): Promise<void> {
    for (const filename of SCHEMA_FILES) {
        const filePath = path.join(__dirname, filename);
        if (!fs.existsSync(filePath)) {
            if (filename === 'schema.sql') throw new Error(`Missing required ${filePath}`);
            throw new Error(`Expected src/db/${filename} but it was not found at ${filePath}. Copy it into src/db/ (next to schema.sql) and restart.`);
        }
        const sql = fs.readFileSync(filePath, 'utf-8');
        await dbExec(sql);
        console.log(`✓ Database migrations complete (${filename})`);
    }
}
