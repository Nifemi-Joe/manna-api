/**
 * src/routes/studio.ts
 * Content entries and media asset management.
 *
 * Content keys can contain slashes (e.g. "landing/hero"), so we encode them
 * in the URL path and use a single wildcard catchall route with action dispatch.
 *
 * Routes:
 * GET    /api/v1/studio/content
 * GET    /api/v1/studio/content/entry?key=landing/hero
 * PATCH  /api/v1/studio/content/entry?key=landing/hero
 * POST   /api/v1/studio/content/publish?key=landing/hero
 * POST   /api/v1/studio/content/rollback?key=landing/hero
 * GET    /api/v1/studio/content/revisions?key=landing/hero
 * GET    /api/v1/studio/media
 * POST   /api/v1/studio/media
 * PATCH  /api/v1/studio/media/:id
 * DELETE /api/v1/studio/media/:id
 */
import { z } from "zod";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import { dbAll, dbGet, dbRun } from "../db";
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./uploads";
const studioRoutes = async (fastify) => {
    // GET /api/v1/studio/content
    fastify.get("/content", async (req) => {
        await req.requirePermission("content:read");
        const entries = dbAll("SELECT * FROM content_entries ORDER BY section, key");
        return { entries: entries.map(formatEntry) };
    });
    // GET /api/v1/studio/content/entry?key=...
    fastify.get("/content/entry", async (req, reply) => {
        await req.requirePermission("content:read");
        const { key } = req.query;
        if (!key)
            return reply.status(400).send({ message: "key query param required" });
        const entry = dbGet("SELECT * FROM content_entries WHERE key = ?", [key]);
        if (!entry)
            return reply.status(404).send({ message: "Content entry not found" });
        return formatEntry(entry);
    });
    // PATCH /api/v1/studio/content/entry?key=...
    fastify.patch("/content/entry", async (req, reply) => {
        const user = await req.requirePermission("content:write");
        const { key } = req.query;
        if (!key)
            return reply.status(400).send({ message: "key query param required" });
        const body = z.object({ content: z.string() }).safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: "content field required" });
        let entry = dbGet("SELECT * FROM content_entries WHERE key = ?", [key]);
        if (!entry) {
            dbRun("INSERT INTO content_entries (key, type, title, status, section, content, edited_by, last_edited_at) VALUES (?, \'markdown\', ?, \'draft\', ?, ?, ?, datetime(\'now\'))", [key, key.split("/").pop() ?? key, key.split("/")[0] ?? "general", body.data.content, user.name]);
        }
        else {
            const newStatus = entry.status === "published" ? "unpublished_changes" : entry.status;
            dbRun("UPDATE content_entries SET content = ?, status = ?, edited_by = ?, last_edited_at = datetime(\'now\') WHERE key = ?", [body.data.content, newStatus, user.name, key]);
        }
        const updated = dbGet("SELECT * FROM content_entries WHERE key = ?", [key]);
        return formatEntry(updated);
    });
    // POST /api/v1/studio/content/publish?key=...
    fastify.post("/content/publish", async (req, reply) => {
        const user = await req.requirePermission("content:publish");
        const { key } = req.query;
        if (!key)
            return reply.status(400).send({ message: "key query param required" });
        const entry = dbGet("SELECT * FROM content_entries WHERE key = ?", [key]);
        if (!entry)
            return reply.status(404).send({ message: "Entry not found" });
        const now = new Date().toISOString();
        dbRun("UPDATE content_entries SET status = \'published\', last_published_at = ?, last_edited_at = ? WHERE key = ?", [now, now, key]);
        dbRun("INSERT INTO content_revisions (id, entry_key, content, published_by, published_at, summary) VALUES (?, ?, ?, ?, ?, \'Published\')", [nanoid(), key, entry.content, user.name, now]);
        const updated = dbGet("SELECT * FROM content_entries WHERE key = ?", [key]);
        return formatEntry(updated);
    });
    // POST /api/v1/studio/content/rollback?key=...
    fastify.post("/content/rollback", async (req, reply) => {
        const user = await req.requirePermission("content:write");
        const { key } = req.query;
        if (!key)
            return reply.status(400).send({ message: "key query param required" });
        const body = z.object({ revisionId: z.string() }).safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: "revisionId required" });
        const revision = dbGet("SELECT * FROM content_revisions WHERE id = ? AND entry_key = ?", [body.data.revisionId, key]);
        if (!revision)
            return reply.status(404).send({ message: "Revision not found" });
        dbRun("UPDATE content_entries SET content = ?, status = \'unpublished_changes\', edited_by = ?, last_edited_at = datetime(\'now\') WHERE key = ?", [revision.content, user.name, key]);
        const updated = dbGet("SELECT * FROM content_entries WHERE key = ?", [key]);
        return formatEntry(updated);
    });
    // GET /api/v1/studio/content/revisions?key=...
    fastify.get("/content/revisions", async (req, reply) => {
        await req.requirePermission("content:read");
        const { key } = req.query;
        if (!key)
            return reply.status(400).send({ message: "key query param required" });
        const revisions = dbAll("SELECT * FROM content_revisions WHERE entry_key = ? ORDER BY published_at DESC", [key]);
        return {
            revisions: revisions.map(r => ({
                id: r.id, key: r.entry_key, content: r.content,
                publishedAt: r.published_at, publishedBy: r.published_by,
                summary: r.summary ?? undefined,
            })),
        };
    });
    // GET /api/v1/studio/media
    fastify.get("/media", async (req) => {
        await req.requirePermission("media:read");
        const assets = dbAll("SELECT * FROM media_assets ORDER BY uploaded_at DESC");
        return { assets: assets.map(formatAsset) };
    });
    // POST /api/v1/studio/media
    fastify.post("/media", async (req, reply) => {
        const user = await req.requirePermission("media:write");
        try {
            const data = await req.file();
            if (!data)
                return reply.status(400).send({ message: "No file uploaded" });
            if (!fs.existsSync(UPLOADS_DIR))
                fs.mkdirSync(UPLOADS_DIR, { recursive: true });
            const ext = path.extname(data.filename);
            const filename = `${nanoid()}-${Date.now()}${ext}`;
            const filepath = path.join(UPLOADS_DIR, filename);
            const buffer = await data.toBuffer();
            fs.writeFileSync(filepath, buffer);
            const id = nanoid();
            const urlBase = process.env.APP_URL ?? "http://localhost:3001";
            const url = `${urlBase}/uploads/${filename}`;
            dbRun("INSERT INTO media_assets (id, filename, url, mime_type, size_bytes, tags, uploaded_by) VALUES (?, ?, ?, ?, ?, \'[]\', ?)", [id, data.filename, url, data.mimetype, buffer.byteLength, user.name]);
            const asset = dbGet("SELECT * FROM media_assets WHERE id = ?", [id]);
            return reply.status(201).send(formatAsset(asset));
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ message: "Upload failed" });
        }
    });
    // PATCH /api/v1/studio/media/:id
    fastify.patch("/media/:id", async (req, reply) => {
        await req.requirePermission("media:write");
        const { id } = req.params;
        const body = z.object({
            alt: z.string().optional(),
            tags: z.array(z.string()).optional(),
        }).safeParse(req.body);
        if (!body.success)
            return reply.status(400).send({ message: "Invalid data" });
        const asset = dbGet("SELECT id FROM media_assets WHERE id = ?", [id]);
        if (!asset)
            return reply.status(404).send({ message: "Asset not found" });
        const updates = [];
        const params = [];
        if (body.data.alt !== undefined) {
            updates.push("alt = ?");
            params.push(body.data.alt);
        }
        if (body.data.tags !== undefined) {
            updates.push("tags = ?");
            params.push(JSON.stringify(body.data.tags));
        }
        if (updates.length) {
            params.push(id);
            dbRun(`UPDATE media_assets SET ${updates.join(", ")} WHERE id = ?`, params);
        }
        const updated = dbGet("SELECT * FROM media_assets WHERE id = ?", [id]);
        return formatAsset(updated);
    });
    // DELETE /api/v1/studio/media/:id
    fastify.delete("/media/:id", async (req, reply) => {
        await req.requirePermission("media:write");
        const { id } = req.params;
        const asset = dbGet("SELECT * FROM media_assets WHERE id = ?", [id]);
        if (!asset)
            return reply.status(404).send({ message: "Asset not found" });
        try {
            const filename = path.basename(asset.url);
            const filepath = path.join(UPLOADS_DIR, filename);
            if (fs.existsSync(filepath))
                fs.unlinkSync(filepath);
        }
        catch { /* ignore */ }
        dbRun("DELETE FROM media_assets WHERE id = ?", [id]);
        return { success: true };
    });
};
function formatEntry(e) {
    return {
        key: e.key, type: e.type, title: e.title, status: e.status, section: e.section,
        content: e.content, editedBy: e.edited_by,
        lastEditedAt: e.last_edited_at,
        lastPublishedAt: e.last_published_at ?? undefined,
    };
}
function formatAsset(a) {
    return {
        id: a.id, filename: a.filename, url: a.url, mimeType: a.mime_type,
        sizeBytes: a.size_bytes, width: a.width ?? undefined, height: a.height ?? undefined,
        alt: a.alt ?? undefined, tags: JSON.parse(a.tags ?? "[]"),
        uploadedAt: a.uploaded_at, uploadedBy: a.uploaded_by,
    };
}
export default studioRoutes;
