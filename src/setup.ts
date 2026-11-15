import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { AnchorError, anchorRequest } from "./anchor-api";
import {
  claudeCodeProfiles,
  desktopConfigPath,
  hasClaudeCli,
  isRegistered,
  registerClaudeCode,
  registerDesktop,
} from "./clients";
import { CONFIG_PATH, loadConfig, normalizeUrl, saveConfig } from "./config";

type Me = { name?: string; email?: string; status?: string };

function prompter() {
  let muted = false;
  // Echo goes through this stream, so muting it hides typed secrets.
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: stdin, output, terminal: stdin.isTTY });
  // Queue lines ourselves: with piped input they arrive before the question is asked.
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => (waiting.length ? waiting.shift()!(line) : lines.push(line)));
  rl.on("close", () => {
    closed = true;
    for (const resolve of waiting.splice(0)) resolve(null);
  });
  const read = async (prompt: string, raw = false) => {
    stdout.write(prompt);
    const line = lines.length ? lines.shift()! : closed ? null : await new Promise<string | null>((r) => waiting.push(r));
    if (line === null) throw new Error("Setup cancelled (input closed).");
    if (!stdin.isTTY) stdout.write("\n");
    return raw ? line.replace(/\r$/, "") : line.trim();
  };
  return {
    async ask(question: string, fallback?: string) {
      const answer = await read(fallback ? `${question} [${fallback}]: ` : `${question}: `);
      return answer || fallback || "";
    },
    /** Hidden input, kept verbatim: a password may start or end with spaces. */
    async secret(question: string) {
      stdout.write(`${question}: `);
      muted = true;
      try {
        return await read("", true);
      } finally {
        muted = false;
        if (stdin.isTTY) stdout.write("\n");
      }
    },
    async yes(question: string, fallback = true) {
      const answer = (await read(`${question} ${fallback ? "[Y/n]" : "[y/N]"}: `)).toLowerCase();
      return answer ? answer.startsWith("y") || answer.startsWith("s") : fallback;
    },
    close: () => rl.close(),
  };
}

/** Runs one setup step, naming it in the error so a 401 says which credential was rejected. */
async function step<T>(label: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (e) {
    throw new Error(`${label} failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function tokenFromLogin(url: string, email: string, password: string): Promise<string> {
  const login = await step("Sign-in (email/password)", () =>
    anchorRequest<{ accessToken?: string; message?: string }>(url, null, "POST", "/auth/login", { email, password }),
  );
  if (!login.accessToken) throw new Error(login.message ?? "Login returned no token (account pending approval?)");
  // Reuse an existing API token: regenerating would break every other client using it.
  const current = await step("Reading your API token", () =>
    anchorRequest<{ apiToken: string | null }>(url, login.accessToken!, "GET", "/auth/api-token"),
  );
  if (current.apiToken) return current.apiToken;
  const created = await step("Creating an API token", () =>
    anchorRequest<{ apiToken: string }>(url, login.accessToken!, "POST", "/auth/api-token/regenerate"),
  );
  return created.apiToken;
}

export async function setup(local: boolean) {
  const p = prompter();
  try {
    console.log("Anchor MCP setup\n");
    const existing = loadConfig();
    const url = normalizeUrl(await p.ask("Anchor URL (e.g. https://notes.example.com)", existing?.url));
    if (!/^https?:\/\//.test(url)) throw new Error("The URL must start with http:// or https://");
    await anchorRequest(url, null, "GET", "/health");

    let token = "";
    if (existing?.token && existing.url === url && (await p.yes("Keep the saved API token?"))) token = existing.token;
    else if (await p.yes("Sign in with email and password? (No = paste an API token)")) {
      const email = await p.ask("Email");
      token = await tokenFromLogin(url, email, await p.secret("Password (not stored)"));
    } else token = await p.secret("API token");

    const me = await step("Checking the API token", () => anchorRequest<Me>(url, token, "GET", "/auth/me"));
    saveConfig({ url, token });
    console.log(`\nConnected as ${me.name ?? me.email}. Saved to ${CONFIG_PATH}\n`);

    if (hasClaudeCli()) {
      for (const profile of claudeCodeProfiles()) {
        if (!(await p.yes(`Add to Claude Code profile ${profile.label}?`))) continue;
        const result = registerClaudeCode(profile, local);
        console.log(result.ok ? "  added" : `  failed:\n${result.output}`);
      }
    } else {
      console.log("Claude Code CLI (`claude`) not found on PATH; skipping Claude Code.");
    }

    const desktop = desktopConfigPath();
    if (desktop && (await p.yes("Add to Claude Desktop?"))) {
      const backup = registerDesktop(desktop, local);
      console.log(`  added${backup ? ` (backup: ${backup})` : ""}. Restart Claude Desktop to load it.`);
    }
    console.log("\nDone. Try asking Claude: \"list my Anchor notes\".");
  } finally {
    p.close();
  }
}

export async function doctor() {
  let healthy = true;
  const check = (ok: boolean, label: string) => {
    healthy &&= ok;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  };
  const config = loadConfig();
  check(Boolean(config), `config (${CONFIG_PATH}, or ANCHOR_URL + ANCHOR_TOKEN)`);
  if (config) {
    try {
      await anchorRequest(config.url, null, "GET", "/health");
      check(true, `server reachable at ${config.url}`);
      const me = await anchorRequest<Me>(config.url, config.token, "GET", "/auth/me");
      check(me.status === undefined || me.status === "active", `token valid, signed in as ${me.name ?? me.email}`);
    } catch (e) {
      check(false, e instanceof AnchorError ? e.message : String(e));
    }
  }
  for (const profile of claudeCodeProfiles()) console.log(`${isRegistered(profile.configFile) ? "ok  " : "--  "} Claude Code: ${profile.label}`);
  const desktop = desktopConfigPath();
  if (desktop) console.log(`${isRegistered(desktop) ? "ok  " : "--  "} Claude Desktop: ${desktop}`);
  process.exitCode = healthy ? 0 : 1;
}
