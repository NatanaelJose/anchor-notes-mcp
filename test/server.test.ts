import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server";
import { API_TOKEN, startFakeAnchor } from "./fake-anchor";

let anchor: Awaited<ReturnType<typeof startFakeAnchor>>;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const text = res.content[0].text;
  return { isError: Boolean(res.isError), text, data: res.isError ? null : JSON.parse(text) };
}

beforeAll(async () => {
  anchor = await startFakeAnchor();
  process.env.ANCHOR_URL = anchor.url;
  process.env.ANCHOR_TOKEN = API_TOKEN;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await anchor.close();
});

describe("tools against a fake Anchor", () => {
  it("advertises instructions, all tools and honest safety hints", async () => {
    expect(client.getInstructions()).toMatch(/search_notes/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_attachment", "append_to_note", "bulk_update_notes", "create_note", "create_tag", "delete_attachment",
      "delete_tag", "export_notes", "find_users", "get_attachment", "get_note", "get_note_version", "list_attachments",
      "list_note_versions", "list_shares", "list_tags", "restore_note", "restore_note_version", "search_notes",
      "share_note", "trash_note", "unshare_note", "update_note", "update_tag",
    ]);
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.get_note?.readOnlyHint).toBe(true);
    expect(hints.delete_attachment?.destructiveHint).toBe(true);
    expect(hints.update_note?.readOnlyHint).toBe(false);
    // No tool may delete a note for good.
    expect(tools.some((t) => /permanent/i.test(t.name))).toBe(false);
  });

  it("stores markdown as Quill Delta and reads it back unchanged", async () => {
    const markdown = "Intro **bold**\n- [ ] task\n";
    const created = await call("create_note", { title: "Delta", content: markdown });
    expect(JSON.parse(anchor.notes.get(created.data.id)!.content).ops).toContainEqual({
      insert: "\n",
      attributes: { list: "unchecked" },
    });
    expect((await call("get_note", { id: created.data.id })).data.content).toBe(markdown);
  });

  it("search returns content, and a miss falls back to recent notes", async () => {
    const hit = await call("search_notes", { search: "Delta" });
    expect(hit.data[0].content).toBe("Intro **bold**\n- [ ] task\n");
    const miss = await call("search_notes", { search: "no-such-text" });
    expect(miss.data.matches).toEqual([]);
    expect(miss.data.recent.length).toBeGreaterThan(0);
  });

  it("truncates long notes in search but not in get_note", async () => {
    const long = `${"word ".repeat(400).trim()}\n`;
    const { data } = await call("create_note", { title: "Long", content: long });
    const [found] = (await call("search_notes", { search: "Long" })).data;
    expect(found.truncated).toBe(true);
    expect((await call("get_note", { id: data.id })).data.content).toBe(long);
  });

  it("rejects a stale update without overwriting, and append survives a concurrent edit", async () => {
    const { data: note } = await call("create_note", { title: "Race", content: "v1\n" });
    await call("append_to_note", { id: note.id, content: "added" });
    const stale = await call("update_note", { id: note.id, baseVersion: note.version, content: "stale" });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/Conflict/);
    expect((await call("get_note", { id: note.id })).data.content).toBe("v1\nadded\n");
  });

  it("trashes notes and encodes ids in paths", async () => {
    const { data } = await call("create_note", { title: "Bye" });
    expect((await call("trash_note", { id: data.id })).isError).toBe(false);
    expect(anchor.notes.get(data.id)!.state).toBe("trashed");
    expect((await call("get_note", { id: "../tags" })).text).toMatch(/404/);
  });

  it("sets background and reminder, and finds notes in trash and archive", async () => {
    const reminder = { remindAt: "2026-12-01T09:00", recurrence: "weekly" };
    const { data } = await call("create_note", { title: "Styled", background: "color_teal", reminder });
    expect(data.background).toBe("color_teal");
    expect(data.reminder).toMatchObject(reminder);
    expect((await call("create_note", { title: "Bad", reminder: { remindAt: "tomorrow 9am" } })).isError).toBe(true);

    await call("trash_note", { id: data.id });
    expect((await call("search_notes", { scope: "trash", search: "styl" })).data.map((n: any) => n.id)).toEqual([data.id]);
    await call("restore_note", { id: data.id });
    expect((await call("search_notes", { scope: "trash" })).data.some((n: any) => n.id === data.id)).toBe(false);
  });

  it("bulk-updates notes", async () => {
    const a = (await call("create_note", { title: "Bulk A" })).data;
    const b = (await call("create_note", { title: "Bulk B" })).data;
    expect((await call("bulk_update_notes", { noteIds: [a.id, b.id], action: "add_tags" })).isError).toBe(true);
    await call("bulk_update_notes", { noteIds: [a.id, b.id], action: "add_tags", tagIds: ["t1"] });
    await call("bulk_update_notes", { noteIds: [a.id, b.id], action: "archive" });
    const archived = (await call("search_notes", { scope: "archived", tagId: "t1" })).data;
    expect(archived.map((n: any) => n.title).sort()).toEqual(["Bulk A", "Bulk B"]);
  });

  it("lists, reads and restores note versions as markdown", async () => {
    const { data: note } = await call("create_note", { title: "History", content: "first **draft**\n" });
    await call("update_note", { id: note.id, baseVersion: note.version, content: "rewritten\n" });
    const { versions } = (await call("list_note_versions", { noteId: note.id })).data;
    expect(versions[0]).toMatchObject({ version: 1, author: "Tester" });
    expect((await call("get_note_version", { noteId: note.id, versionId: versions[0].id })).data.content).toBe(
      "first **draft**\n",
    );
    const restored = (await call("restore_note_version", { noteId: note.id, versionId: versions[0].id })).data;
    expect(restored.content).toBe("first **draft**\n");
  });

  it("uploads, shows, saves and deletes attachments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anchor-mcp-test-"));
    const png = join(dir, "photo.png");
    writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
    writeFileSync(join(dir, "secret.txt"), "nope");
    const { data: note } = await call("create_note", { title: "Media" });

    const rejected = await call("add_attachment", { noteId: note.id, filePath: join(dir, "secret.txt") });
    expect(rejected.isError).toBe(true);
    const added = (await call("add_attachment", { noteId: note.id, filePath: png })).data;
    expect(added).toMatchObject({ filename: "photo.png", mimeType: "image/png", sizeBytes: 8 });
    expect((await call("list_attachments", { noteId: note.id })).data).toHaveLength(1);
    expect((await call("get_note", { id: note.id })).data.attachmentCount).toBe(1);

    const inline = (await client.callTool({
      name: "get_attachment",
      arguments: { noteId: note.id, attachmentId: added.id },
    })) as { content: any[] };
    expect(inline.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from(inline.content[1].data, "base64")).toEqual(readFileSync(png));

    const out = join(dir, "out");
    const first = (await call("get_attachment", { noteId: note.id, attachmentId: added.id, saveTo: out })).data;
    const second = (await call("get_attachment", { noteId: note.id, attachmentId: added.id, saveTo: out })).data;
    expect(first.savedTo).toBe(join(out, "photo.png"));
    expect(second.savedTo).toBe(join(out, "photo (1).png"));

    expect((await call("delete_attachment", { noteId: note.id, attachmentId: added.id })).isError).toBe(false);
    expect((await call("list_attachments", { noteId: note.id })).data).toHaveLength(0);
  });

  it("finds users, shares and unshares", async () => {
    const { data: note } = await call("create_note", { title: "Shared" });
    const [maria] = (await call("find_users", { query: "mar" })).data;
    expect(maria).toEqual({ id: "u2", name: "Maria", email: "maria@example.com" });
    await call("share_note", { noteId: note.id, userId: maria.id, permission: "editor" });
    const [share] = (await call("list_shares", { noteId: note.id })).data;
    expect(share.permission).toBe("editor");
    await call("unshare_note", { noteId: note.id, shareId: share.id });
    expect((await call("list_shares", { noteId: note.id })).data).toEqual([]);
  });

  it("renames and deletes tags", async () => {
    await call("update_tag", { id: "t1", name: "job" });
    expect((await call("list_tags")).data[0].name).toBe("job");
    await call("delete_tag", { id: "t1" });
    expect((await call("list_tags")).data).toEqual([]);
  });

  it("exports a zip to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anchor-mcp-test-"));
    const { data } = await call("export_notes", { saveTo: dir });
    expect(data.savedTo).toBe(join(dir, "anchor-markdown-2026-11-15.zip"));
    expect(readFileSync(data.savedTo).subarray(0, 2).toString()).toBe("PK");
  });

  it("reports a bad token as a tool error", async () => {
    process.env.ANCHOR_TOKEN = "wrong";
    try {
      const res = await call("list_tags");
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/401/);
    } finally {
      process.env.ANCHOR_TOKEN = API_TOKEN;
    }
  });
});
