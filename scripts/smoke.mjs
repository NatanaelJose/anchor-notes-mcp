// End-to-end check against a real Anchor: creates a note, reads it back, appends,
// provokes a version conflict and trashes the note. Uses the saved config or
// ANCHOR_URL/ANCHOR_TOKEN. Run `npm run build` first.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MARKDOWN = [
  "Smoke test from **anchor-notes-mcp**, safe to delete.",
  "",
  "## Checklist",
  "- [ ] open this note in Anchor",
  "- [x] *italic*, ~~strike~~, <u>underline</u>, ==highlight==",
  "    - [ ] nested item",
  "1. numbered",
  "> quote with a [link](https://example.com)",
  "```",
  "code block",
  "```",
  "",
].join("\n");

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/cli.js"], env: process.env }));

async function call(name, args, { expectError = false } = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  assert.equal(Boolean(res.isError), expectError, `${name}: ${text}`);
  console.log(`ok  ${name}`);
  return expectError ? text : JSON.parse(text);
}

let noteId;
try {
  const created = await call("create_note", { title: "anchor-notes-mcp smoke test", content: MARKDOWN });
  noteId = created.id;
  const read = await call("get_note", { id: noteId });
  assert.equal(read.content, MARKDOWN, "markdown should come back exactly as written");

  await call("append_to_note", { id: noteId, content: "- [ ] appended by smoke test" });
  const appended = await call("get_note", { id: noteId });
  assert.equal(appended.content, `${MARKDOWN}- [ ] appended by smoke test\n`);

  const conflict = await call(
    "update_note",
    { id: noteId, baseVersion: created.version, content: "stale write" },
    { expectError: true },
  );
  assert.match(conflict, /Conflict/);
  assert.equal((await call("get_note", { id: noteId })).content, appended.content, "stale write must not land");

  const found = await call("search_notes", { search: "smoke test" });
  assert.ok(found.some((n) => n.id === noteId), "search should find the note");
  assert.equal(found.find((n) => n.id === noteId).content, appended.content, "search should carry the content");
  const miss = await call("search_notes", { search: "zzqq-no-such-text" });
  assert.ok(miss.recent.some((n) => n.id === noteId), "a miss should fall back to recent notes");
  await call("list_tags", {});

  // History: the stale write above is kept as a conflict version; restore the original text.
  const { versions } = await call("list_note_versions", { noteId });
  const original = versions.find((v) => v.version === created.version && v.cause !== "conflict");
  assert.ok(original, "the first version should be in history");
  assert.equal((await call("get_note_version", { noteId, versionId: original.id })).content, MARKDOWN);
  await call("restore_note_version", { noteId, versionId: original.id });
  assert.equal((await call("get_note", { id: noteId })).content, MARKDOWN);

  // Attachments: a real 1x1 PNG, shown inline, then deleted.
  const png = join(mkdtempSync(join(tmpdir(), "anchor-smoke-")), "pixel.png");
  writeFileSync(png, Buffer.from(PIXEL_PNG, "base64"));
  const attachment = await call("add_attachment", { noteId, filePath: png });
  const shown = await client.callTool({ name: "get_attachment", arguments: { noteId, attachmentId: attachment.id } });
  assert.equal(shown.content[1]?.type, "image", "the image should come back inline");
  console.log("ok  get_attachment (inline image)");
  await call("delete_attachment", { noteId, attachmentId: attachment.id });
  assert.deepEqual(await call("list_attachments", { noteId }), []);

  if (process.argv.includes("--keep")) console.log(`\nKept note ${noteId}: open it in Anchor to check the formatting, then trash it.`);
  else {
    await call("trash_note", { id: noteId });
    const trashed = await call("search_notes", { scope: "trash", search: "smoke test" });
    assert.ok(trashed.some((n) => n.id === noteId), "the note should be in the trash");
  }
  console.log("\nAll good.");
} catch (e) {
  console.error(`\nFAILED: ${e.message}${noteId ? `\n(note ${noteId} may be left over; trash it in Anchor)` : ""}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
