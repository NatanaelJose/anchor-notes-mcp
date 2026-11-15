import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SERVER_NAME = "anchor";
const isWindows = process.platform === "win32";

/** How a Claude client should start this server: from npm, or from this checkout (`--local`). */
export function serverCommand(local: boolean): { command: string; args: string[] } {
  if (local) return { command: process.execPath, args: [resolve(process.argv[1])] };
  // Claude clients on Windows can't spawn npx (a .cmd shim) directly.
  return isWindows
    ? { command: "cmd", args: ["/c", "npx", "-y", "anchor-notes-mcp"] }
    : { command: "npx", args: ["-y", "anchor-notes-mcp"] };
}

export type CodeProfile = { label: string; configDir: string | null; configFile: string };

/** Claude Code profiles: the default (~/.claude.json) plus each ~/.claude* dir that holds its own .claude.json. */
export function claudeCodeProfiles(): CodeProfile[] {
  const home = homedir();
  const profiles: CodeProfile[] = [];
  const defaultFile = join(home, ".claude.json");
  if (existsSync(defaultFile)) profiles.push({ label: "default (~/.claude.json)", configDir: null, configFile: defaultFile });
  const dirs = readdirSync(home)
    .filter((name) => /^\.claude(-.+)?$/.test(name))
    .map((name) => join(home, name));
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(resolve(process.env.CLAUDE_CONFIG_DIR));
  for (const dir of new Set(dirs)) {
    const file = join(dir, ".claude.json");
    if (existsSync(file) && statSync(dir).isDirectory()) profiles.push({ label: dir, configDir: dir, configFile: file });
  }
  return profiles;
}

/** Runs the `claude` CLI: directly when it is an executable, through the shell when it is a .cmd shim (npm installs on Windows). */
function runClaude(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const direct = spawnSync("claude", args, { env, encoding: "utf8" });
  if (!(isWindows && (direct.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")) return direct;
  const line = ["claude", ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
  return spawnSync(line, { env, encoding: "utf8", shell: true });
}

export function hasClaudeCli(): boolean {
  return runClaude(["--version"]).status === 0;
}

/** Registers the server at user scope in one Claude Code profile, replacing an older entry. */
export function registerClaudeCode(profile: CodeProfile, local: boolean): { ok: boolean; output: string } {
  const env = { ...process.env };
  if (profile.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  runClaude(["mcp", "remove", SERVER_NAME, "--scope", "user"], env);
  const { command, args } = serverCommand(local);
  const result = runClaude(["mcp", "add", "--scope", "user", SERVER_NAME, "--", command, ...args], env);
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export function desktopConfigPath(): string | null {
  const home = homedir();
  const dir =
    process.platform === "win32"
      ? join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude")
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Claude")
        : join(home, ".config", "Claude");
  return existsSync(dir) ? join(dir, "claude_desktop_config.json") : null;
}

/** Adds the server to Claude Desktop's config, keeping everything else and a backup of the old file. */
export function registerDesktop(file: string, local: boolean): string | null {
  let config: Record<string, any> = {};
  let backup: string | null = null;
  if (existsSync(file)) {
    config = JSON.parse(readFileSync(file, "utf8")); // throws on broken JSON rather than overwriting it
    backup = `${file}.bak-${Date.now()}`;
    copyFileSync(file, backup);
  }
  config.mcpServers = { ...config.mcpServers, [SERVER_NAME]: serverCommand(local) };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return backup;
}

export function isRegistered(configFile: string): boolean {
  try {
    return Boolean(JSON.parse(readFileSync(configFile, "utf8")).mcpServers?.[SERVER_NAME]);
  } catch {
    return false;
  }
}
