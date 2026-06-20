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

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import { dbAll, dbGet, dbRun } from "../db/index.js";

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./uploads";

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
}

const studioRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/studio/content
  fastify.get("/content", async (req) => {
    await req.requirePermission("content:read");
    const entries = await dbAll<any>("SELECT * FROM content_entries ORDER BY section, key");
    return { entries: entries.map(formatEntry) };
  });

  // GET /api/v1/studio/content/entry?key=...
  fastify.get("/content/entry", async (req, reply) => {
    await req.requirePermission("content:read");
    const { key } = req.query as { key?: string };
    if (!key) return reply.status(400).send({ message: "key query param required" });

    const entry = await dbGet<any>("SELECT * FROM content_entries WHERE key = $1", [key]);
    if (!entry) return reply.status(404).send({ message: "Content entry not found" });
    return formatEntry(entry);
  });

  // PATCH /api/v1/studio/content/entry?key=...
  fastify.patch("/content/entry", async (req, reply) => {
    const user = await req.requirePermission("content:write");
    const { key } = req.query as { key?: string };
    if (!key) return reply.status(400).send({ message: "key query param required" });

    const body = z.object({ content: z.string() }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "content field required" });

    const entry = await dbGet<any>("SELECT * FROM content_entries WHERE key = $1", [key]);

    if (!entry) {
      await dbRun(
        `INSERT INTO content_entries (key, type, title, status, section, content, edited_by, last_edited_at)
         VALUES ($1, 'markdown', $2, 'draft', $3, $4, $5, now())`,
        [key, key.split("/").pop() ?? key, key.split("/")[0] ?? "general", body.data.content, user.name]
      );
    } else {
      const newStatus = entry.status === "published" ? "unpublished_changes" : entry.status;
      await dbRun(
        `UPDATE content_entries SET content = $1, status = $2, edited_by = $3, last_edited_at = now() WHERE key = $4`,
        [body.data.content, newStatus, user.name, key]
      );
    }

    const updated = await dbGet<any>("SELECT * FROM content_entries WHERE key = $1", [key]);
    return formatEntry(updated!);
  });

  // POST /api/v1/studio/content/publish?key=...
  fastify.post("/content/publish", async (req, reply) => {
    const user = await req.requirePermission("content:publish");
    const { key } = req.query as { key?: string };
    if (!key) return reply.status(400).send({ message: "key query param required" });

    const entry = await dbGet<any>("SELECT * FROM content_entries WHERE key = $1", [key]);
    if (!entry) return reply.status(404).send({ message: "Entry not found" });

    const now = new Date().toISOString();
    await dbRun(
      `UPDATE content_entries SET status = 'published', last_published_at = $1, last_edited_at = $2 WHERE key = $3`,
      [now, now, key]
    );
    await dbRun(
      `INSERT INTO content_revisions (id, entry_key, content, published_by, published_at, summary)
       VALUES ($1, $2, $3, $4, $5, 'Published')`,
      [nanoid(), key, entry.content, user.name, now]
    );

    const updated = await dbGet<any>("SELECT * FROM content_entries WHERE key = $1", [key]);
    return formatEntry(updated!);
  });

  // POST /api/v1/studio/content/rollback?key=...
  fastify.post("/content/rollback", async (req, reply) => {
    const user = await req.requirePermission("content:write");
    const { key } = req.query as { key?: string };
    if (!key) return reply.status(400).send({ message: "key query param required" });

    const body = z.object({ revisionId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "revisionId required" });

    const revision = await dbGet<any>(
      "SELECT * FROM content_revisions WHERE id = $1 AND entry_key = $2",
      [body.data.revisionId, key]
    );
    if (!revision) return reply.status(404).send({ message: "Revision not found" });

    await dbRun(
      `UPDATE content_entries SET content = $1, status = 'unpublished_changes', edited_by = $2, last_edited_at = now() WHERE key = $3`,
      [revision.content, user.name, key]
    );

    const updated = await dbGet<any>("SELECT * FROM content_entries WHERE key = $1", [key]);
    return formatEntry(updated!);
  });

  // GET /api/v1/studio/content/revisions?key=...
  fastify.get("/content/revisions", async (req, reply) => {
    await req.requirePermission("content:read");
    const { key } = req.query as { key?: string };
    if (!key) return reply.status(400).send({ message: "key query param required" });

    const revisions = await dbAll<any>(
      "SELECT * FROM content_revisions WHERE entry_key = $1 ORDER BY published_at DESC",
      [key]
    );

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
    const assets = await dbAll<any>("SELECT * FROM media_assets ORDER BY uploaded_at DESC");
    return { assets: assets.map(formatAsset) };
  });

  // POST /api/v1/studio/media
  fastify.post("/media", async (req, reply) => {
    const user = await req.requirePermission("media:write");
    try {
      const data = await req.file();
      if (!data) return reply.status(400).send({ message: "No file uploaded" });

      if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

      const ext = path.extname(data.filename);
      const filename = `${nanoid()}-${Date.now()}${ext}`;
      const filepath = path.join(UPLOADS_DIR, filename);

      const buffer = await data.toBuffer();
      fs.writeFileSync(filepath, buffer);

      const id = nanoid();
      const urlBase = process.env.APP_URL ?? "http://localhost:3001";
      const url = `${urlBase}/uploads/${filename}`;

      await dbRun(
        `INSERT INTO media_assets (id, filename, url, mime_type, size_bytes, tags, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, '[]', $6)`,
        [id, data.filename, url, data.mimetype, buffer.byteLength, user.name]
      );

      const asset = await dbGet<any>("SELECT * FROM media_assets WHERE id = $1", [id]);
      return reply.status(201).send(formatAsset(asset!));
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ message: "Upload failed" });
    }
  });

  // PATCH /api/v1/studio/media/:id
  fastify.patch("/media/:id", async (req, reply) => {
    await req.requirePermission("media:write");
    const { id } = req.params as { id: string };

    const body = z.object({
      alt: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ message: "Invalid data" });

    const asset = await dbGet("SELECT id FROM media_assets WHERE id = $1", [id]);
    if (!asset) return reply.status(404).send({ message: "Asset not found" });

    const updates: string[] = [];
    const params: unknown[] = [];
    if (body.data.alt !== undefined)  { params.push(body.data.alt);                     updates.push(`alt = $${params.length}`); }
    if (body.data.tags !== undefined) { params.push(JSON.stringify(body.data.tags));    updates.push(`tags = $${params.length}`); }

    if (updates.length) {
      params.push(id);
      await dbRun(`UPDATE media_assets SET ${updates.join(", ")} WHERE id = $${params.length}`, params);
    }

    const updated = await dbGet<any>("SELECT * FROM media_assets WHERE id = $1", [id]);
    return formatAsset(updated!);
  });

  // DELETE /api/v1/studio/media/:id
  fastify.delete("/media/:id", async (req, reply) => {
    await req.requirePermission("media:write");
    const { id } = req.params as { id: string };

    const asset = await dbGet<any>("SELECT * FROM media_assets WHERE id = $1", [id]);
    if (!asset) return reply.status(404).send({ message: "Asset not found" });

    try {
      const filename = path.basename(asset.url);
      const filepath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch { /* ignore */ }

    await dbRun("DELETE FROM media_assets WHERE id = $1", [id]);
    return { success: true };
  });
};

function formatEntry(e: any) {
  return {
    key: e.key, type: e.type, title: e.title, status: e.status, section: e.section,
    content: e.content, editedBy: e.edited_by,
    lastEditedAt: e.last_edited_at,
    lastPublishedAt: e.last_published_at ?? undefined,
  };
}

function formatAsset(a: any) {
  return {
    id: a.id, filename: a.filename, url: a.url, mimeType: a.mime_type,
    sizeBytes: a.size_bytes, width: a.width ?? undefined, height: a.height ?? undefined,
    alt: a.alt ?? undefined, tags: asArray(a.tags),
    uploadedAt: a.uploaded_at, uploadedBy: a.uploaded_by,
  };
}

export default studioRoutes;