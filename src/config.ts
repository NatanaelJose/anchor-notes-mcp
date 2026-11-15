import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Config = { url: string; token: string };

export const CONFIG_PATH =
  process.env.ANCHOR_MCP_CONFIG ?? join(homedir(), ".config", "anchor-notes-mcp", "config.json");

export const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");

/** Env vars win over the config file, so one machine can point at several instances. */
export function loadConfig(): Config | null {
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // no config file yet
  }
  const url = process.env.ANCHOR_URL ?? file.url;
  const token = process.env.ANCHOR_TOKEN ?? file.token;
  return url && token ? { url: normalizeUrl(url), token } : null;
}

export function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600); // the token is a password; keep it owner-only where the OS allows
}
