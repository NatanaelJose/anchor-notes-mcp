import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AnchorError, anchorDownload, anchorRequest } from "./anchor-api";
import { CONFIG_PATH, loadConfig } from "./config";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_BY_EXT, attachmentMime, saveFile } from "./files";
import { appendMarkdown, toDelta, toMarkdown } from "./markdown";
import { VERSION } from "./version";

type Note = {
  id: string;
  title: string;
  content: string | null;
  version: number;
  isPinned: boolean;
  isArchived: boolean;
  tagIds: string[];
  updatedAt: string;
  background?: string | null;
  state?: string;
  attachmentCount?: number;
  permission?: string;
  reminder?: { remindAt: string; recurrence: string } | null;
};
type Person = { id: string; name: string; email: string };
type Revision = {
  id: string;
  version: number;
  title: string;
  cause: string;
  createdAt: string;
  author: Person | null;
  content?: string | null;
};
type Attachment = {
  id: string;
  type: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
};

// Long enough that most notes come back whole from a search, saving a get_note round trip per note.
const PREVIEW = 1500;
// Images up to this size are shown to the model inline; larger ones are saved to disk.
const INLINE_IMAGE_MAX = 3.5 * 1024 * 1024;

function view(note: Note, full: boolean) {
  const markdown = toMarkdown(note.content);
  const truncated = !full && markdown.length > PREVIEW;
  return {
    id: note.id,
    title: note.title,
    content: truncated ? `${markdown.slice(0, PREVIEW)}…` : markdown,
    ...(truncated && { truncated: true }),
    tagIds: note.tagIds,
    isPinned: note.isPinned,
    isArchived: note.isArchived,
    version: note.version,
    updatedAt: note.updatedAt,
    ...(note.state && note.state !== "active" ? { state: note.state } : {}),
    ...(note.background ? { background: note.background } : {}),
    ...(note.reminder ? { reminder: note.reminder } : {}),
    ...(note.attachmentCount ? { attachmentCount: note.attachmentCount } : {}),
    ...(note.permission && note.permission !== "owner" ? { permission: note.permission } : {}),
  };
}

const revisionView = (r: Revision) => ({
  id: r.id,
  version: r.version,
  title: r.title,
  cause: r.cause,
  createdAt: r.createdAt,
  author: r.author?.name ?? r.author?.email ?? null,
  ...(r.content !== undefined && { content: toMarkdown(r.content) }),
});

const attachmentView = (a: Attachment) => ({
  id: a.id,
  type: a.type,
  filename: a.originalFilename,
  mimeType: a.mimeType,
  sizeBytes: a.fileSize,
  createdAt: a.createdAt,
});

function config() {
  const loaded = loadConfig();
  if (!loaded) {
    throw new AnchorError(0, `Anchor is not configured. Run \`npx anchor-notes-mcp setup\` (config: ${CONFIG_PATH}).`, null);
  }
  return loaded;
}
const api = <T = any>(method: string, path: string, body?: Record<string, unknown> | FormData) => {
  const { url, token } = config();
  return anchorRequest<T>(url, token, method, path, body);
};
const download = (path: string) => {
  const { url, token } = config();
  return anchorDownload(url, token, path);
};

/** Marks a handler result that is already a full MCP result (e.g. with an image). */
class Raw {
  constructor(readonly result: CallToolResult) {}
}

function conflictMessage(e: AnchorError) {
  const current = (e.body as { serverNote?: Note } | null)?.serverNote;
  return (
    "Conflict: the note changed since the version you read (probably edited in the Anchor app). " +
    `Nothing was overwritten. Current version is ${current?.version ?? "unknown"}; ` +
    "call get_note again, re-apply your change to the new content and retry."
  );
}

/** Runs a tool body, turning Anchor errors into tool errors the model can act on. */
async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await body();
    if (value instanceof Raw) return value.result;
    return { content: [{ type: "text", text: JSON.stringify(value ?? { ok: true }, null, 2) }] };
  } catch (e) {
    const text = e instanceof AnchorError && e.status === 409 ? conflictMessage(e) : e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text }], isError: true };
  }
}

const id = (value: string) => encodeURIComponent(value);
const query = (params: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) q.set(key, String(value));
  return q.size ? `?${q}` : "";
};

const markdownField = z.string().describe(
  "Markdown. Supported: # headings (1-3), **bold**, *italic*, <u>underline</u>, ~~strike~~, ==highlight==, " +
    "[links](url), - bullets, 1. numbered, - [ ] / - [x] checklists (nest with 4 spaces), > quotes, ``` code blocks.",
);
const BACKGROUNDS = [
  "color_red", "color_orange", "color_yellow", "color_green", "color_teal", "color_blue", "color_dark_blue",
  "color_purple", "color_pink", "color_brown", "pattern_dots", "pattern_grid", "pattern_lines", "pattern_waves",
  "pattern_groceries", "pattern_music", "pattern_travel", "pattern_code",
] as const;
const backgroundField = z.enum(BACKGROUNDS).nullable().describe("Note background; null clears it");
const reminderField = z
  .object({
    remindAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .describe("Local wall-clock time on the user's devices, YYYY-MM-DDTHH:mm"),
    recurrence: z.enum(["none", "daily", "weekly", "monthly", "yearly"]).optional(),
  })
  .nullable()
  .describe("Reminder; null removes it");
const noteFields = {
  title: z.string(),
  content: markdownField,
  tagIds: z.array(z.string()).describe("Tag ids from list_tags"),
  isPinned: z.boolean(),
  background: backgroundField,
  reminder: reminderField,
};
const withDelta = ({ content, ...rest }: { content?: string; [key: string]: unknown }) => ({
  ...rest,
  ...(content !== undefined && { content: toDelta(content) }),
});

const INSTRUCTIONS = `Anchor is the user's notes app. Use these tools whenever they mention their notes, Anchor, or ask to note/remember/write something down.
- Start with search_notes: without \`search\` it lists recent notes, and every result already includes the note content as markdown (cut at ${PREVIEW} chars, marked truncated). Only call get_note for a truncated note or before update_note. Use scope "archived" or "trash" to look there.
- Search is plain substring matching, not semantic: use one short distinctive word. If nothing matches, the result includes recent notes, so you rarely need a second search.
- To add to a note use append_to_note; use update_note (with the version from get_note) only to rewrite or remove text. Every edit is kept in the note's history (list_note_versions / restore_note_version), so a bad edit can be undone.
- Content is markdown; titles go in \`title\`, not as a heading in the content.
- Attachments (images and audio) live outside the note text: list_attachments, get_attachment (shows images to you), add_attachment (from a local file).
- Notes can't be deleted permanently from here: trash_note moves them to the trash (restore_note brings them back).`;

type Kind = "read" | "write" | "destructive";

export function createServer() {
  const server = new McpServer({ name: "anchor-notes", version: VERSION }, { instructions: INSTRUCTIONS });

  function tool<Shape extends z.ZodRawShape>(
    name: string,
    kind: Kind,
    description: string,
    inputSchema: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: { readOnlyHint: kind === "read", destructiveHint: kind === "destructive", openWorldHint: false },
      },
      ((args: z.infer<z.ZodObject<Shape>>) => run(() => handler(args))) as any,
    );
  }

  // ---------------------------------------------------------------- notes

  tool(
    "search_notes",
    "read",
    "List (no `search`) or search the user's Anchor notes. Results include each note's markdown content " +
      `(first ${PREVIEW} chars). If a search of active notes matches nothing, recent notes are returned instead.`,
    {
      search: z.string().optional().describe("Substring to find in titles and content; one short word works best"),
      scope: z.enum(["active", "archived", "trash"]).optional().describe("Default active"),
      tagId: z.string().optional().describe("Only notes with this tag (ids from list_tags)"),
      limit: z.number().int().positive().max(200).optional().describe("Default 20"),
    },
    async ({ search, scope = "active", tagId, limit = 20 }) => {
      if (scope !== "active") {
        // These lists have no server-side filters.
        const needle = search?.toLowerCase();
        const notes = (await api<Note[]>("GET", `/notes/${scope === "trash" ? "trash" : "archive"}`))
          .filter((n) => !tagId || n.tagIds?.includes(tagId))
          .map((n) => view(n, false))
          .filter((n) => !needle || `${n.title}\n${n.content}`.toLowerCase().includes(needle));
        return notes.slice(0, limit);
      }
      const list = async (params: Record<string, unknown>) =>
        (await api<Note[]>("GET", `/notes${query({ ...params, limit })}`)).map((n) => view(n, false));
      const notes = await list({ search, tagId });
      if (notes.length || !search) return notes;
      // Saves the model a second round trip after a miss.
      return { matches: [], message: `No notes match "${search}". Recent notes:`, recent: await list({ tagId }) };
    },
  );

  tool(
    "get_note",
    "read",
    "Read one whole note as markdown, with its current version. Needed only for notes search_notes marked " +
      "truncated, or to get the version before update_note.",
    { id: z.string() },
    async (a) => view(await api<Note>("GET", `/notes/${id(a.id)}`), true),
  );

  tool(
    "create_note",
    "write",
    "Create a note. Put the title in `title`, not as a heading in `content`.",
    {
      ...noteFields,
      content: noteFields.content.optional(),
      tagIds: noteFields.tagIds.optional(),
      isPinned: noteFields.isPinned.optional(),
      background: noteFields.background.optional(),
      reminder: noteFields.reminder.optional(),
    },
    async (a) => view(await api<Note>("POST", "/notes", withDelta(a)), true),
  );

  tool(
    "update_note",
    "write",
    "Change a note. `content` replaces the whole body, so read the note with get_note first and send the full " +
      "edited markdown. To only add text at the end, use append_to_note instead.",
    {
      id: z.string(),
      baseVersion: z.number().int().positive().describe("`version` from the get_note you based this edit on"),
      title: noteFields.title.optional(),
      content: noteFields.content.optional(),
      tagIds: noteFields.tagIds.optional().describe("Replaces the note's tags"),
      isPinned: noteFields.isPinned.optional(),
      isArchived: z.boolean().optional(),
      background: noteFields.background.optional(),
      reminder: noteFields.reminder.optional(),
    },
    async ({ id: noteId, ...changes }) => view(await api<Note>("PATCH", `/notes/${id(noteId)}`, withDelta(changes)), true),
  );

  tool(
    "append_to_note",
    "write",
    "Add markdown to the end of a note without touching its existing content or formatting.",
    { id: z.string(), content: markdownField },
    async ({ id: noteId, content }) => {
      // One retry covers an edit landing between our read and write.
      for (let attempt = 0; ; attempt++) {
        const note = await api<Note>("GET", `/notes/${id(noteId)}`);
        try {
          const body = { content: appendMarkdown(note.content, content), baseVersion: note.version };
          return view(await api<Note>("PATCH", `/notes/${id(noteId)}`, body), true);
        } catch (e) {
          if (!(e instanceof AnchorError && e.status === 409) || attempt > 0) throw e;
        }
      }
    },
  );

  tool(
    "trash_note",
    "write",
    "Move a note to the trash (restore_note brings it back; the trash empties itself after 30 days). " +
      "On a note shared with the user, this leaves the share instead.",
    { id: z.string() },
    (a) => api("DELETE", `/notes/${id(a.id)}`),
  );

  tool(
    "restore_note",
    "write",
    "Bring a note back from the trash.",
    { id: z.string() },
    async (a) => view(await api<Note>("PATCH", `/notes/${id(a.id)}/restore`), true),
  );

  tool(
    "bulk_update_notes",
    "write",
    "Apply one action to many notes at once: trash, archive, pin, unpin, or add_tags (adds `tagIds`, keeps existing tags).",
    {
      noteIds: z.array(z.string()).min(1).max(200),
      action: z.enum(["trash", "archive", "pin", "unpin", "add_tags"]),
      tagIds: z.array(z.string()).min(1).max(50).optional().describe("Required for add_tags"),
    },
    async ({ noteIds, action, tagIds }) => {
      if (action === "add_tags" && !tagIds) throw new Error("add_tags needs tagIds");
      const [path, extra] = {
        trash: ["delete", {}],
        archive: ["archive", {}],
        pin: ["pin", { isPinned: true }],
        unpin: ["pin", { isPinned: false }],
        add_tags: ["tags", { tagIds }],
      }[action] as [string, Record<string, unknown>];
      return api("POST", `/notes/bulk/${path}`, { noteIds, ...extra });
    },
  );

  // ---------------------------------------------------------------- history

  tool(
    "list_note_versions",
    "read",
    "List a note's saved versions, newest first (every edit, restore and conflict is kept).",
    {
      noteId: z.string(),
      limit: z.number().int().positive().max(100).optional().describe("Default 30"),
      cursor: z.string().optional().describe("nextCursor from the previous page"),
    },
    async ({ noteId, ...params }) => {
      const page = await api<{ revisions: Revision[]; nextCursor: string | null }>(
        "GET",
        `/notes/${id(noteId)}/revisions${query(params)}`,
      );
      return { versions: page.revisions.map(revisionView), nextCursor: page.nextCursor };
    },
  );

  tool(
    "get_note_version",
    "read",
    "Read one saved version of a note as markdown.",
    { noteId: z.string(), versionId: z.string().describe("id from list_note_versions") },
    async (a) => revisionView(await api<Revision>("GET", `/notes/${id(a.noteId)}/revisions/${id(a.versionId)}`)),
  );

  tool(
    "restore_note_version",
    "write",
    "Restore a note's title and content to a saved version. The current text is kept in history first, so this can be undone.",
    { noteId: z.string(), versionId: z.string() },
    async (a) => view(await api<Note>("POST", `/notes/${id(a.noteId)}/revisions/${id(a.versionId)}/restore`), true),
  );

  // ---------------------------------------------------------------- attachments

  tool(
    "list_attachments",
    "read",
    "List a note's attachments (images and audio).",
    { noteId: z.string() },
    async (a) => (await api<Attachment[]>("GET", `/notes/${id(a.noteId)}/attachments`)).map(attachmentView),
  );

  tool(
    "get_attachment",
    "read",
    `Get an attachment. Images up to ${INLINE_IMAGE_MAX / 1024 / 1024} MB are shown to you directly; audio and ` +
      "larger images are saved to disk (never overwriting) and the path is returned. Pass `saveTo` to always save.",
    {
      noteId: z.string(),
      attachmentId: z.string(),
      saveTo: z.string().optional().describe("Folder or file path; default is the user's Downloads folder"),
    },
    async ({ noteId, attachmentId, saveTo }) => {
      const file = await download(`/notes/${id(noteId)}/attachments/${id(attachmentId)}`);
      const meta = { filename: file.filename, mimeType: file.mimeType, sizeBytes: file.bytes.length };
      if (!saveTo && file.mimeType.startsWith("image/") && file.bytes.length <= INLINE_IMAGE_MAX) {
        return new Raw({
          content: [
            { type: "text", text: JSON.stringify(meta) },
            { type: "image", data: file.bytes.toString("base64"), mimeType: file.mimeType },
          ],
        });
      }
      return { ...meta, savedTo: saveFile(saveTo, file.filename ?? `${attachmentId}`, file.bytes) };
    },
  );

  tool(
    "add_attachment",
    "write",
    `Attach a local file to a note. Anchor accepts images and audio up to 50 MB (${Object.keys(ATTACHMENT_MIME_BY_EXT).join(" ")}).`,
    { noteId: z.string(), filePath: z.string().describe("Absolute path of the local file") },
    async ({ noteId, filePath }) => {
      const path = resolve(filePath);
      const mimeType = attachmentMime(path);
      if (!mimeType) throw new Error(`Anchor only accepts images and audio (${Object.keys(ATTACHMENT_MIME_BY_EXT).join(" ")}).`);
      const size = statSync(path).size;
      if (size > ATTACHMENT_MAX_BYTES) throw new Error(`File is ${(size / 1024 / 1024).toFixed(1)} MB; Anchor's limit is 50 MB.`);
      const form = new FormData();
      form.append("file", new Blob([readFileSync(path)], { type: mimeType }), basename(path));
      return attachmentView(await api<Attachment>("POST", `/notes/${id(noteId)}/attachments`, form));
    },
  );

  tool(
    "delete_attachment",
    "destructive",
    "Permanently delete an attachment from a note (the file is removed from the server; this cannot be undone).",
    { noteId: z.string(), attachmentId: z.string() },
    (a) => api("DELETE", `/notes/${id(a.noteId)}/attachments/${id(a.attachmentId)}`),
  );

  // ---------------------------------------------------------------- sharing

  tool(
    "find_users",
    "read",
    "Find Anchor users on this server by name or email (to share a note with them).",
    { query: z.string().min(1) },
    async (a) =>
      (await api<Person[]>("GET", `/users/search${query({ q: a.query })}`)).map(({ id, name, email }) => ({ id, name, email })),
  );

  tool(
    "list_shares",
    "read",
    "List who a note is shared with.",
    { noteId: z.string() },
    (a) => api("GET", `/notes/${id(a.noteId)}/shares`),
  );

  tool(
    "share_note",
    "write",
    "Share a note with another user of this Anchor server, or change their permission if already shared.",
    {
      noteId: z.string(),
      userId: z.string().describe("id from find_users"),
      permission: z.enum(["viewer", "editor"]),
    },
    (a) => api("POST", `/notes/${id(a.noteId)}/shares`, { sharedWithUserId: a.userId, permission: a.permission }),
  );

  tool(
    "unshare_note",
    "destructive",
    "Stop sharing a note with someone.",
    { noteId: z.string(), shareId: z.string().describe("id from list_shares") },
    (a) => api("DELETE", `/notes/${id(a.noteId)}/shares/${id(a.shareId)}`),
  );

  // ---------------------------------------------------------------- tags

  tool("list_tags", "read", "List tags (id, name, color).", {}, () => api("GET", "/tags"));

  tool(
    "create_tag",
    "write",
    "Create a tag.",
    { name: z.string().min(1), color: z.string().optional() },
    (a) => api("POST", "/tags", a),
  );

  tool(
    "update_tag",
    "write",
    "Rename a tag or change its color.",
    { id: z.string(), name: z.string().min(1).optional(), color: z.string().optional() },
    ({ id: tagId, ...changes }) => api("PATCH", `/tags/${id(tagId)}`, changes),
  );

  tool(
    "delete_tag",
    "destructive",
    "Delete a tag. Notes keep existing; they just lose this tag.",
    { id: z.string() },
    (a) => api("DELETE", `/tags/${id(a.id)}`),
  );

  // ---------------------------------------------------------------- export

  tool(
    "export_notes",
    "read",
    "Download a zip backup of all the user's notes. `markdown` = readable .md files; `anchor` = Anchor's own " +
      "format, for re-importing. Saved to disk (never overwriting); returns the path.",
    {
      format: z.enum(["markdown", "anchor"]).optional().describe("Default markdown"),
      saveTo: z.string().optional().describe("Folder or file path; default is the user's Downloads folder"),
    },
    async ({ format = "markdown", saveTo }) => {
      const file = await download(`/export${query({ format })}`);
      return { savedTo: saveFile(saveTo, file.filename ?? `anchor-${format}.zip`, file.bytes), sizeBytes: file.bytes.length };
    },
  );

  return server;
}

export async function startServer() {
  await createServer().connect(new StdioServerTransport());
}
