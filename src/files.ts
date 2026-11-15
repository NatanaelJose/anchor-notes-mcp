import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, parse, resolve } from "node:path";

/** What Anchor accepts as attachments (server/src/notes/constants/notes.constants.ts, v0.18.0). */
export const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/x-m4a",
  ".mp4": "audio/mp4",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".weba": "audio/webm",
  ".webm": "audio/webm",
};
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

export const attachmentMime = (path: string) => ATTACHMENT_MIME_BY_EXT[extname(path).toLowerCase()];

export function defaultDownloadDir() {
  const downloads = join(homedir(), "Downloads");
  return existsSync(downloads) ? downloads : tmpdir();
}

/**
 * Writes bytes into `target` (a folder, or a file path) without ever overwriting:
 * an existing name gets " (1)", " (2)"… Returns the path written.
 */
export function saveFile(target: string | undefined, suggestedName: string, bytes: Buffer): string {
  let path = resolve(target ?? defaultDownloadDir());
  // Names from the server are used as a file name only, never as a path.
  const safeName = basename(suggestedName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || "download";
  if (!extname(path) || (existsSync(path) && statSync(path).isDirectory())) {
    mkdirSync(path, { recursive: true });
    path = join(path, safeName);
  } else {
    mkdirSync(parse(path).dir, { recursive: true });
  }
  const { dir, name, ext } = parse(path);
  for (let i = 0; ; i++) {
    const candidate = i ? join(dir, `${name} (${i})${ext}`) : path;
    try {
      writeFileSync(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
