/**
 * src/db/index.ts
 * SQLite database wrapper using sql.js (pure JS, no native compilation).
 * Provides a synchronous-style API identical to better-sqlite3's interface
 * so routes feel clean. Persists to disk via fs.writeFileSync on every write.
 */
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
const DB_PATH = process.env.DB_PATH ?? './data/manna.db';
let SQL;
let _db;
function persistDb() {
    const data = _db.export();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, Buffer.from(data));
}
export async function initDb() {
    SQL = await initSqlJs();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        _db = new SQL.Database(fileBuffer);
    }
    else {
        _db = new SQL.Database();
        persistDb();
    }
    // Enable WAL-equivalent pragmas
    _db.run('PRAGMA journal_mode = MEMORY;');
    _db.run('PRAGMA foreign_keys = ON;');
    return _db;
}
export function getDb() {
    if (!_db)
        throw new Error('Database not initialized. Call initDb() first.');
    return _db;
}
/** Execute a statement and persist. Returns number of changes. */
export function dbRun(sql, params = []) {
    _db.run(sql, params);
    persistDb();
    return _db.getRowsModified?.() ?? 0;
}
/** Query and return all rows as objects. */
export function dbAll(sql, params = []) {
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}
/** Query and return first row or undefined. */
export function dbGet(sql, params = []) {
    const results = dbAll(sql, params);
    return results[0];
}
/** Execute raw SQL (for DDL). Does NOT persist — call persistDb() after. */
export function dbExec(sql) {
    _db.run(sql);
}
export { persistDb };
