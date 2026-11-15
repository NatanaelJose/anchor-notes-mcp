// In-process fake of the Anchor REST routes this server uses, mirroring the real
// behaviors that matter: `access_token` on login, /auth/me rejecting API tokens,
// version-checked PATCH answering 409 with the server copy, revisions kept on
// every edit, multipart attachment uploads, zip export.
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const API_TOKEN = "test-api-token";
const JWT = "test-session-jwt";

type Note = Record<string, any>;
type StoredAttachment = { id: string; noteId: string; bytes: Buffer; mimeType: string; originalFilename: string };

export async function startFakeAnchor() {
  const notes = new Map<string, Note>();
  const revisions: Record<string, any>[] = [];
  const attachments = new Map<string, StoredAttachment>();
  const shares: Record<string, any>[] = [];
  const tags = [{ id: "t1", name: "work", color: null as string | null }];
  const users = [{ id: "u2", name: "Maria", email: "maria@example.com" }];
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const withCount = (note: Note) => ({
    ...note,
    attachmentCount: [...attachments.values()].filter((a) => a.noteId === note.id).length,
  });

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] ?? "";
    const body = contentType.startsWith("application/json") && raw.length ? JSON.parse(raw.toString()) : {};
    const url = new URL(req.url!, "http://x");
    const path = url.pathname;
    const auth = req.headers.authorization;
    const m = (re: RegExp) => path.match(re);

    if (path === "/api/health") return json(res, 200, { status: "ok" });
    if (path === "/api/auth/login")
      return body.password === "pw"
        ? json(res, 200, { access_token: JWT, refresh_token: "r", user: { name: "Tester" } })
        : json(res, 401, { message: "Invalid credentials" });
    if (path.startsWith("/api/auth/")) {
      if (auth !== `Bearer ${JWT}`) return json(res, 401, { message: "Unauthorized" });
      if (path === "/api/auth/api-token") return json(res, 200, { apiToken: null });
      if (path === "/api/auth/api-token/regenerate") return json(res, 200, { apiToken: API_TOKEN });
    }
    if (auth !== `Bearer ${API_TOKEN}`) return json(res, 401, { message: "Invalid authentication token" });

    // tags
    if (path === "/api/tags")
      return req.method === "POST" ? json(res, 201, { id: "t2", ...body }) : json(res, 200, tags);
    let match = m(/^\/api\/tags\/([^/]+)$/);
    if (match) {
      const tag = tags.find((t) => t.id === match![1]);
      if (!tag) return json(res, 404, { message: "Tag not found" });
      if (req.method === "PATCH") return json(res, 200, Object.assign(tag, body));
      if (req.method === "DELETE") {
        tags.splice(tags.indexOf(tag), 1);
        return json(res, 200, { success: true });
      }
    }

    // users, export
    if (path === "/api/users/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json(res, 200, users.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q)));
    }
    if (path === "/api/export") {
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="anchor-${url.searchParams.get("format")}-2026-11-15.zip"`,
      });
      return res.end(Buffer.from("PK\u0003\u0004fake-zip"));
    }

    // note lists and bulk
    if (path === "/api/notes" && req.method === "GET") {
      const q = url.searchParams.get("search");
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const found = [...notes.values()].filter(
        (n) => n.state === "active" && !n.isArchived && (!q || n.title.includes(q) || (n.content ?? "").includes(q)),
      );
      return json(res, 200, found.slice(0, limit).map(withCount));
    }
    if (path === "/api/notes/trash") return json(res, 200, [...notes.values()].filter((n) => n.state === "trashed"));
    if (path === "/api/notes/archive")
      return json(res, 200, [...notes.values()].filter((n) => n.state === "active" && n.isArchived));
    match = m(/^\/api\/notes\/bulk\/(\w+)$/);
    if (match) {
      for (const noteId of body.noteIds) {
        const note = notes.get(noteId);
        if (!note) continue;
        if (match[1] === "delete") note.state = "trashed";
        if (match[1] === "archive") note.isArchived = true;
        if (match[1] === "pin") note.isPinned = body.isPinned;
        if (match[1] === "tags") note.tagIds = [...new Set([...note.tagIds, ...body.tagIds])];
      }
      return json(res, 200, { count: body.noteIds.length });
    }
    if (path === "/api/notes" && req.method === "POST") {
      const note = {
        id: randomUUID(),
        title: body.title,
        content: body.content ?? null,
        version: 1,
        isPinned: Boolean(body.isPinned),
        isArchived: false,
        tagIds: body.tagIds ?? [],
        background: body.background ?? null,
        reminder: body.reminder ? { recurrence: "none", version: 1, ...body.reminder } : null,
        state: "active",
        updatedAt: new Date().toISOString(),
        permission: "owner",
      };
      notes.set(note.id, note);
      return json(res, 201, note);
    }

    // per-note subresources
    match = m(/^\/api\/notes\/([^/]+)(?:\/(.*))?$/);
    const note = notes.get(match?.[1] ?? "");
    if (!note) return json(res, 404, { message: "Note not found" });
    const sub = match![2] ?? "";

    if (sub === "restore") {
      note.state = "active";
      return json(res, 200, note);
    }
    if (sub === "revisions") {
      const list = revisions.filter((r) => r.noteId === note.id).reverse();
      return json(res, 200, { revisions: list.map(({ content, ...summary }) => summary), nextCursor: null });
    }
    match = sub.match(/^revisions\/([^/]+)(\/restore)?$/);
    if (match) {
      const revision = revisions.find((r) => r.id === match![1] && r.noteId === note.id);
      if (!revision) return json(res, 404, { message: "Revision not found" });
      if (!match[2]) return json(res, 200, revision);
      revisions.push({ ...revision, id: randomUUID(), version: note.version, title: note.title, content: note.content, cause: "restore" });
      Object.assign(note, { title: revision.title, content: revision.content, version: note.version + 1 });
      return json(res, 200, note);
    }
    if (sub === "attachments") {
      if (req.method === "POST") {
        const form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
        const file = form.get("file") as File;
        const attachment = {
          id: randomUUID(),
          noteId: note.id,
          bytes: Buffer.from(await file.arrayBuffer()),
          mimeType: file.type,
          originalFilename: file.name,
        };
        attachments.set(attachment.id, attachment);
        return json(res, 201, { ...attachment, bytes: undefined, type: file.type.split("/")[0], fileSize: attachment.bytes.length });
      }
      return json(
        res,
        200,
        [...attachments.values()]
          .filter((a) => a.noteId === note.id)
          .map((a) => ({ ...a, bytes: undefined, type: a.mimeType.split("/")[0], fileSize: a.bytes.length })),
      );
    }
    match = sub.match(/^attachments\/([^/]+)$/);
    if (match) {
      const attachment = attachments.get(match[1]);
      if (!attachment || attachment.noteId !== note.id) return json(res, 404, { message: "Attachment not found" });
      if (req.method === "DELETE") {
        attachments.delete(attachment.id);
        return json(res, 200, { success: true });
      }
      res.writeHead(200, {
        "Content-Type": attachment.mimeType,
        "Content-Disposition": `inline; filename="${encodeURIComponent(attachment.originalFilename)}"`,
      });
      return res.end(attachment.bytes);
    }
    if (sub === "shares") {
      if (req.method === "POST") {
        const share = { id: randomUUID(), noteId: note.id, sharedWithUser: users.find((u) => u.id === body.sharedWithUserId), permission: body.permission };
        shares.push(share);
        return json(res, 201, share);
      }
      return json(res, 200, shares.filter((s) => s.noteId === note.id));
    }
    match = sub.match(/^shares\/([^/]+)$/);
    if (match && req.method === "DELETE") {
      shares.splice(shares.findIndex((s) => s.id === match![1]), 1);
      return json(res, 200, { success: true });
    }
    if (sub) return json(res, 404, { message: "Not found" });

    if (req.method === "GET") return json(res, 200, withCount(note));
    if (req.method === "DELETE") {
      note.state = "trashed";
      return json(res, 200, { success: true });
    }
    if (req.method === "PATCH") {
      const { baseVersion, ...changes } = body;
      if (baseVersion !== undefined && baseVersion !== note.version)
        return json(res, 409, { message: "Note was changed by someone else", serverNote: note });
      revisions.push({
        id: randomUUID(),
        noteId: note.id,
        version: note.version,
        title: note.title,
        content: note.content,
        cause: "edit",
        createdAt: new Date().toISOString(),
        author: { id: "u1", name: "Tester", email: "t@example.com" },
      });
      Object.assign(note, changes, { version: note.version + 1, updatedAt: new Date().toISOString() });
      return json(res, 200, note);
    }
    json(res, 405, {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    notes,
    attachments,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
