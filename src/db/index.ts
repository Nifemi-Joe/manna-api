/**
 * src/db/index.ts
 * SQLite database wrapper using sql.js (pure JS, no native compilation).
 * Provides a synchronous-style API identical to better-sqlite3's interface
 * so routes feel clean. Persists to disk via fs.writeFileSync on every write.
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH ?? './data/manna.db';

let SQL: SqlJsStatic;
let _db: Database;

function persistDb() {
    const data = _db.export();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, Buffer.from(data));
}

export async function initDb(): Promise<Database> {
    SQL = await initSqlJs();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        _db = new SQL.Database(fileBuffer);
    } else {
        _db = new SQL.Database();
        persistDb();
    }

    // Enable WAL-equivalent pragmas
    _db.run('PRAGMA journal_mode = MEMORY;');
    _db.run('PRAGMA foreign_keys = ON;');

    return _db;
}

export function getDb(): Database {
    if (!_db) throw new Error('Database not initialized. Call initDb() first.');
    return _db;
}

/** Execute a statement and persist. Returns number of changes. */
export function dbRun(sql: string, params: unknown[] = []): number {
    _db.run(sql, params as any[]);
    persistDb();
    return (_db as any).getRowsModified?.() ?? 0;
}

/** Query and return all rows as objects. */
export function dbAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = _db.prepare(sql);
    stmt.bind(params as any[]);
    const rows: T[] = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
}

/** Query and return first row or undefined. */
export function dbGet<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    const results = dbAll<T>(sql, params);
    return results[0];
}

/** Execute raw SQL (for DDL). Does NOT persist — call persistDb() after. */
export function dbExec(sql: string) {
    _db.run(sql);
}

export { persistDb };