import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AnchorError, anchorRequest } from "./anchor-api";
import { CONFIG_PATH, loadConfig } from "./config";
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
  attachmentCount?: number;
  permission?: string;
};

const SNIPPET = 200;

function view(note: Note, full: boolean) {
  const markdown = toMarkdown(note.content);
  return {
    id: note.id,
    title: note.title,
    ...(full
      ? { content: markdown }
      : { snippet: markdown.length > SNIPPET ? `${markdown.slice(0, SNIPPET)}…` : markdown }),
    tagIds: note.tagIds,
    isPinned: note.isPinned,
    isArchived: note.isArchived,
    version: note.version,
    updatedAt: note.updatedAt,
    ...(note.attachmentCount ? { attachmentCount: note.attachmentCount } : {}),
    ...(note.permission && note.permission !== "owner" ? { permission: note.permission } : {}),
  };
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function api<T = any>(method: string, path: string, body?: unknown) {
  const config = loadConfig();
  if (!config) {
    throw new AnchorError(0, `Anchor is not configured. Run \`npx anchor-notes-mcp setup\` (config: ${CONFIG_PATH}).`, null);
  }
  return anchorRequest<T>(config.url, config.token, method, path, body);
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
async function run(body: () => Promise<unknown>) {
  try {
    return ok(await body());
  } catch (e) {
    if (e instanceof AnchorError && e.status === 409) return fail(conflictMessage(e));
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const id = (value: string) => encodeURIComponent(value);
const markdownField = z.string().describe(
  "Markdown. Supported: # headings (1-3), **bold**, *italic*, <u>underline</u>, ~~strike~~, ==highlight==, " +
    "[links](url), - bullets, 1. numbered, - [ ] / - [x] checklists (nest with 4 spaces), > quotes, ``` code blocks.",
);

export function createServer() {
  const server = new McpServer({ name: "anchor-notes", version: VERSION });

  server.registerTool(
    "search_notes",
    {
      description: "List or search active notes in Anchor. Returns snippets; use get_note for the full content.",
      inputSchema: {
        search: z.string().optional().describe("Text to search in titles and content"),
        tagId: z.string().optional().describe("Only notes with this tag (ids from list_tags)"),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    (args) =>
      run(async () => {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(args)) if (value !== undefined) query.set(key, String(value));
        const notes = await api<Note[]>("GET", `/notes${query.size ? `?${query}` : ""}`);
        return notes.map((note) => view(note, false));
      }),
  );

  server.registerTool(
    "get_note",
    {
      description: "Read one note as markdown, with its current version (needed by update_note).",
      inputSchema: { id: z.string() },
    },
    ({ id: noteId }) => run(async () => view(await api<Note>("GET", `/notes/${id(noteId)}`), true)),
  );

  server.registerTool(
    "create_note",
    {
      description: "Create a note. Put the title in `title`, not as a heading in `content`.",
      inputSchema: {
        title: z.string(),
        content: markdownField.optional(),
        tagIds: z.array(z.string()).optional(),
        isPinned: z.boolean().optional(),
      },
    },
    ({ content, ...rest }) =>
      run(async () =>
        view(await api<Note>("POST", "/notes", { ...rest, ...(content !== undefined && { content: toDelta(content) }) }), true),
      ),
  );

  server.registerTool(
    "update_note",
    {
      description:
        "Change a note. `content` replaces the whole body, so read the note with get_note first and send the full " +
        "edited markdown. To only add text at the end, use append_to_note instead.",
      inputSchema: {
        id: z.string(),
        baseVersion: z.number().int().positive().describe("`version` from the get_note you based this edit on"),
        title: z.string().optional(),
        content: markdownField.optional(),
        tagIds: z.array(z.string()).optional().describe("Replaces the note's tags"),
        isPinned: z.boolean().optional(),
        isArchived: z.boolean().optional(),
      },
    },
    ({ id: noteId, content, ...rest }) =>
      run(async () =>
        view(
          await api<Note>("PATCH", `/notes/${id(noteId)}`, {
            ...rest,
            ...(content !== undefined && { content: toDelta(content) }),
          }),
          true,
        ),
      ),
  );

  server.registerTool(
    "append_to_note",
    {
      description: "Add markdown to the end of a note without touching its existing content or formatting.",
      inputSchema: { id: z.string(), content: markdownField },
    },
    ({ id: noteId, content }) =>
      run(async () => {
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
      }),
  );

  server.registerTool(
    "trash_note",
    {
      description: "Move a note to the trash (it can be restored from the Anchor app).",
      inputSchema: { id: z.string() },
    },
    ({ id: noteId }) => run(() => api("DELETE", `/notes/${id(noteId)}`)),
  );

  server.registerTool(
    "list_tags",
    { description: "List tags (id, name, color).", inputSchema: {} },
    () => run(() => api("GET", "/tags")),
  );

  server.registerTool(
    "create_tag",
    {
      description: "Create a tag.",
      inputSchema: { name: z.string().min(1), color: z.string().optional() },
    },
    (args) => run(() => api("POST", "/tags", args)),
  );

  return server;
}

export async function startServer() {
  await createServer().connect(new StdioServerTransport());
}
