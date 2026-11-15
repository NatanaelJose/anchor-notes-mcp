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
  it("advertises instructions and all tools", async () => {
    expect(client.getInstructions()).toMatch(/search_notes/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["append_to_note", "create_note", "create_tag", "get_note", "list_tags", "search_notes", "trash_note", "update_note"],
    );
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
