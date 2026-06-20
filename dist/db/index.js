/**
 * src/db/index.ts
 * PostgreSQL database wrapper using `pg`, designed for Neon's serverless Postgres.
 *
 * Mirrors the previous sql.js API shape (dbRun/dbAll/dbGet/dbExec) so route
 * files stay structurally similar — the key difference is every function is
 * now async and must be awaited, since Postgres is a network database.
 *
 * IMPORTANT — SQL placeholder syntax changed:
 *   sql.js / better-sqlite3 used positional `?` placeholders.
 *   Postgres uses numbered placeholders: $1, $2, $3, ...
 *   Every query string across the codebase needs this updated.
 */
import { Pool } from 'pg';
const CONNECTION_STRING = process.env.DATABASE_URL;
if (!CONNECTION_STRING) {
    throw new Error('DATABASE_URL is not set. Add your Neon connection string to .env, e.g.\n' +
        'DATABASE_URL=postgresql://user:password@ep-xxxx.neon.tech/dbname?sslmode=require');
}
let pool;
/**
 * Initializes the connection pool and verifies connectivity.
 * Call once at app startup before any queries run.
 */
export async function initDb() {
    pool = new Pool({
        connectionString: CONNECTION_STRING,
        // Neon requires SSL; `sslmode=require` in the URL handles this, but we
        // also set it explicitly here in case the URL omits it.
        ssl: { rejectUnauthorized: false },
        max: 10, // Neon pooled endpoints handle concurrency themselves
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
    });
    // Verify the connection works before continuing app boot.
    const client = await pool.connect();
    try {
        await client.query('SELECT 1');
    }
    finally {
        client.release();
    }
    return pool;
}
export function getDb() {
    if (!pool)
        throw new Error('Database not initialized. Call initDb() first.');
    return pool;
}
/**
 * Execute an INSERT/UPDATE/DELETE statement.
 * Returns the number of rows affected.
 *
 * NOTE: query strings must use Postgres placeholders ($1, $2, ...), not `?`.
 */
export async function dbRun(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rowCount ?? 0;
}
/** Query and return all rows as objects. */
export async function dbAll(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows;
}
/** Query and return the first row, or undefined if no rows matched. */
export async function dbGet(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows[0];
}
/** Execute raw SQL — used for DDL (CREATE TABLE, etc). No return value. */
export async function dbExec(sql) {
    await pool.query(sql);
}
/**
 * Run multiple statements inside a single transaction.
 * Pass an async function that receives a scoped query runner; if it throws,
 * the transaction rolls back automatically.
 *
 * Usage:
 *   await withTransaction(async (tx) => {
 *     await tx.run('UPDATE ... WHERE id = $1', [id]);
 *     await tx.run('INSERT INTO ... VALUES ($1, $2)', [a, b]);
 *   });
 */
export async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tx = {
            run: async (sql, params = []) => {
                const r = await client.query(sql, params);
                return r.rowCount ?? 0;
            },
            all: async (sql, params = []) => {
                const r = await client.query(sql, params);
                return r.rows;
            },
            get: async (sql, params = []) => {
                const r = await client.query(sql, params);
                return r.rows[0];
            },
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
    }
    catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        client.release();
    }
}
/** Gracefully close the pool — call on app shutdown. */
export async function closeDb() {
    if (pool)
        await pool.end();
}
