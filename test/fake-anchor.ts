// In-process fake of the Anchor REST routes this server uses, mirroring the real
// behaviors that matter: `access_token` on login, /auth/me rejecting API tokens,
// version-checked PATCH answering 409 with the server copy.
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const API_TOKEN = "test-api-token";
const JWT = "test-session-jwt";

type Note = Record<string, any>;

export async function startFakeAnchor() {
  const notes = new Map<string, Note>();
  const tags = [{ id: "t1", name: "work", color: null }];
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://x");
    const path = url.pathname;
    const auth = req.headers.authorization;

    if (path === "/api/health") return send(res, 200, { status: "ok" });
    if (path === "/api/auth/login")
      return body.password === "pw"
        ? send(res, 200, { access_token: JWT, refresh_token: "r", user: { name: "Tester" } })
        : send(res, 401, { message: "Invalid credentials" });
    if (path.startsWith("/api/auth/")) {
      if (auth !== `Bearer ${JWT}`) return send(res, 401, { message: "Unauthorized" });
      if (path === "/api/auth/api-token") return send(res, 200, { apiToken: null });
      if (path === "/api/auth/api-token/regenerate") return send(res, 200, { apiToken: API_TOKEN });
    }
    if (auth !== `Bearer ${API_TOKEN}`) return send(res, 401, { message: "Invalid authentication token" });

    if (path === "/api/tags") return req.method === "POST" ? send(res, 201, { id: "t2", ...body }) : send(res, 200, tags);
    if (path === "/api/notes" && req.method === "GET") {
      const q = url.searchParams.get("search");
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const found = [...notes.values()].filter(
        (n) => n.state === "active" && (!q || n.title.includes(q) || (n.content ?? "").includes(q)),
      );
      return send(res, 200, found.slice(0, limit));
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
        state: "active",
        updatedAt: new Date().toISOString(),
        permission: "owner",
      };
      notes.set(note.id, note);
      return send(res, 201, note);
    }
    const note = notes.get(path.match(/^\/api\/notes\/([^/]+)$/)?.[1] ?? "");
    if (!note) return send(res, 404, { message: "Note not found" });
    if (req.method === "GET") return send(res, 200, note);
    if (req.method === "DELETE") {
      note.state = "trashed";
      return send(res, 200, { success: true });
    }
    if (req.method === "PATCH") {
      const { baseVersion, ...changes } = body;
      if (baseVersion !== undefined && baseVersion !== note.version)
        return send(res, 409, { message: "Note was changed by someone else", serverNote: note });
      Object.assign(note, changes, { version: note.version + 1, updatedAt: new Date().toISOString() });
      return send(res, 200, note);
    }
    send(res, 405, {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    notes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
