/**
 * src/routes/hr-employees-bulk.ts
 * POST /api/v1/hr/employees/bulk-upload
 *
 * Registered as a separate plugin under the same `/hr` prefix as your
 * existing hr.ts (see index.ts) rather than editing that file directly —
 * avoids re-pasting ~300 lines just to add one route.
 *
 * Accepts a CSV or Excel (.xlsx/.xls) file via multipart upload. Expected
 * columns (header row required, case-insensitive, order doesn't matter):
 *
 *   name, email, department, allowance_lunch, allowance_breakfast, phone
 *
 * `allowance_lunch` / `allowance_breakfast` are optional per-row overrides
 * — if blank, the employee falls back to the company's default rule (see
 * allowance_rules). This is the "assign how much they can spend" per
 * person during upload.
 *
 * Requires the `xlsx` package for Excel support:
 *   npm install xlsx
 * CSV parsing is done with a small dependency-free parser below — no
 * extra package needed for that path.
 */

import type { FastifyPluginAsync } from 'fastify';
import { nanoid } from 'nanoid';
import { dbGet, dbRun } from '../db/index.js';

interface ParsedRow {
    name: string;
    email: string;
    department?: string;
    allowanceLunch?: number;
    allowanceBreakfast?: number;
    phone?: string;
}

interface RowResult {
    row: number;
    email: string;
    status: 'created' | 'skipped' | 'error';
    reason?: string;
}

/** Minimal RFC 4180-ish CSV parser — handles quoted fields and commas within quotes. */
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const next = text[i + 1];

        if (inQuotes) {
            if (char === '"' && next === '"') { field += '"'; i++; }
            else if (char === '"') { inQuotes = false; }
            else { field += char; }
        } else {
            if (char === '"') inQuotes = true;
            else if (char === ',') { row.push(field); field = ''; }
            else if (char === '\n' || char === '\r') {
                if (char === '\r' && next === '\n') i++;
                row.push(field);
                field = '';
                if (row.some((c) => c.trim() !== '')) rows.push(row);
                row = [];
            } else field += char;
        }
    }
    if (field.length || row.length) {
        row.push(field);
        if (row.some((c) => c.trim() !== '')) rows.push(row);
    }
    return rows;
}

function normalizeHeader(h: string): string {
    return h.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function rowsToObjects(rows: string[][]): Record<string, string>[] {
    if (rows.length === 0) return [];
    const headers = rows[0].map(normalizeHeader);
    return rows.slice(1).map((r) => {
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
        return obj;
    });
}

function parseNumericCell(v: string | undefined): number | undefined {
    if (!v) return undefined;
    const n = Number(v.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

async function parseUploadedFile(filename: string, mimetype: string, buffer: Buffer): Promise<ParsedRow[]> {
    const isExcel = /\.(xlsx|xls)$/i.test(filename) || mimetype.includes('spreadsheet') || mimetype.includes('excel');

    let objects: Record<string, string>[];

    if (isExcel) {
        // Lazy import so a CSV-only deployment doesn't need the `xlsx`
        // package installed at all if it never uploads Excel files.
        const XLSX = await import('xlsx').catch(() => {
            throw new Error("Excel upload requires the 'xlsx' package — run `npm install xlsx`");
        });
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
        objects = rowsToObjects(rows);
    } else {
        const text = buffer.toString('utf-8');
        objects = rowsToObjects(parseCsv(text));
    }

    return objects
        .filter((o) => o.email || o.name)
        .map((o) => ({
            name: o.name ?? '',
            email: (o.email ?? '').toLowerCase(),
            department: o.department || undefined,
            allowanceLunch: parseNumericCell(o.allowance_lunch ?? o.allowance ?? o.lunch_allowance),
            allowanceBreakfast: parseNumericCell(o.allowance_breakfast ?? o.breakfast_allowance),
            phone: o.phone || undefined,
        }));
}

const hrBulkUploadRoutes: FastifyPluginAsync = async (fastify) => {
    // POST /api/v1/hr/employees/bulk-upload
    fastify.post('/employees/bulk-upload', async (req, reply) => {
        const user = await req.requirePermission('employees:write');
        if (!user.companyId) return reply.status(403).send({ message: 'No company associated with account' });

        const file = await req.file();
        if (!file) return reply.status(400).send({ message: 'No file uploaded. Attach a CSV or Excel file as `file`.' });

        const buffer = await file.toBuffer();
        if (buffer.byteLength === 0) return reply.status(400).send({ message: 'Uploaded file is empty' });

        let rows: ParsedRow[];
        try {
            rows = await parseUploadedFile(file.filename, file.mimetype, buffer);
        } catch (err: any) {
            return reply.status(400).send({ message: err?.message ?? 'Could not parse file' });
        }

        if (rows.length === 0) {
            return reply.status(400).send({ message: 'No rows found. Expected a header row with at least `name` and `email` columns.' });
        }
        if (rows.length > 500) {
            return reply.status(400).send({ message: 'Max 500 rows per upload. Split into multiple files.' });
        }

        const empRole = await dbGet<{ id: string }>(`SELECT id FROM roles WHERE id = 'role-employee'`);
        const results: RowResult[] = [];
        let created = 0;

        for (let i = 0; i < rows.length; i++) {
            const rowNum = i + 2; // +1 for 0-index, +1 for header row
            const row = rows[i];

            if (!row.email || !row.email.includes('@')) {
                results.push({ row: rowNum, email: row.email || '(blank)', status: 'error', reason: 'Missing or invalid email' });
                continue;
            }
            if (!row.name) {
                results.push({ row: rowNum, email: row.email, status: 'error', reason: 'Missing name' });
                continue;
            }

            const existing = await dbGet('SELECT id FROM users WHERE email = $1', [row.email]);
            if (existing) {
                results.push({ row: rowNum, email: row.email, status: 'skipped', reason: 'Email already exists' });
                continue;
            }

            const id = nanoid();
            await dbRun(
                `INSERT INTO users (
                    id, email, name, portal, company_id, status, department, phone,
                    allowance_override_lunch, allowance_override_breakfast
                 ) VALUES ($1, $2, $3, 'employee', $4, 'active', $5, $6, $7, $8)`,
                [
                    id, row.email, row.name, user.companyId,
                    row.department ?? null, row.phone ?? null,
                    row.allowanceLunch ?? null, row.allowanceBreakfast ?? null,
                ]
            );

            if (empRole) {
                await dbRun(
                    `INSERT INTO role_assignments (id, user_id, role_id, assigned_by, status)
                     VALUES ($1, $2, 'role-employee', $3, 'active')`,
                    [nanoid(), id, user.id]
                );
            }

            results.push({ row: rowNum, email: row.email, status: 'created' });
            created++;
        }

        return reply.status(201).send({
            summary: {
                totalRows: rows.length,
                created,
                skipped: results.filter((r) => r.status === 'skipped').length,
                errors: results.filter((r) => r.status === 'error').length,
            },
            results,
        });
    });
};

export default hrBulkUploadRoutes;
