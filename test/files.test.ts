import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentMime, saveFile } from "../src/files";

describe("saveFile", () => {
  it("keeps server-provided names inside the target folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "anchor-mcp-files-"));
    const path = saveFile(dir, "../../evil.png", Buffer.from("x"));
    expect(path).toBe(join(dir, "evil.png"));
    expect(existsSync(join(dir, "..", "evil.png"))).toBe(false);
  });

  it("never overwrites, including an explicit file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "anchor-mcp-files-"));
    const target = join(dir, "backup.zip");
    expect(saveFile(target, "ignored.zip", Buffer.from("1"))).toBe(target);
    expect(saveFile(target, "ignored.zip", Buffer.from("2"))).toBe(join(dir, "backup (1).zip"));
    expect(readFileSync(target, "utf8")).toBe("1");
    expect(readdirSync(dir).sort()).toEqual(["backup (1).zip", "backup.zip"]);
  });

  it("creates a missing folder", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "anchor-mcp-files-")), "new", "folder");
    expect(saveFile(dir, "a.png", Buffer.from("x"))).toBe(join(dir, "a.png"));
  });
});

describe("attachmentMime", () => {
  it("accepts only what Anchor accepts", () => {
    expect(attachmentMime("C:/x/Photo.JPG")).toBe("image/jpeg");
    expect(attachmentMime("voice.m4a")).toBe("audio/x-m4a");
    expect(attachmentMime("notes.txt")).toBeUndefined();
    expect(attachmentMime("id_rsa")).toBeUndefined();
  });
});
