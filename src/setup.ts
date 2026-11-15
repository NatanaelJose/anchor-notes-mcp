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
    // Through readline, not stdout: in a terminal it redraws the line with its own prompt ("> " by default).
    if (closed) output.write(prompt); // piped input already ended; queued lines are still answered
    else {
      rl.setPrompt(prompt);
      rl.prompt();
    }
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

type Login = { access_token?: string; message?: string; user?: Me };

async function tokenFromLogin(url: string, email: string, password: string): Promise<{ token: string; user?: Me }> {
  const login = await step("Sign-in (email/password)", () =>
    anchorRequest<Login>(url, null, "POST", "/auth/login", { email, password }),
  );
  const jwt = login.access_token;
  if (!jwt) throw new Error(login.message ?? "Login returned no token (account pending approval?)");
  // Reuse an existing API token: regenerating would break every other client using it.
  const current = await step("Reading your API token", () =>
    anchorRequest<{ apiToken: string | null }>(url, jwt, "GET", "/auth/api-token"),
  );
  if (current.apiToken) return { token: current.apiToken, user: login.user };
  const created = await step("Creating an API token", () =>
    anchorRequest<{ apiToken: string }>(url, jwt, "POST", "/auth/api-token/regenerate"),
  );
  return { token: created.apiToken, user: login.user };
}

/** /auth/me only takes session JWTs; the note and tag routes are the ones that accept API tokens. */
export const checkApiToken = (url: string, token: string) => anchorRequest(url, token, "GET", "/tags");

export async function setup(local: boolean) {
  const p = prompter();
  try {
    console.log("Anchor MCP setup\n");
    const existing = loadConfig();
    const url = normalizeUrl(await p.ask("Anchor URL (e.g. https://notes.example.com)", existing?.url));
    if (!/^https?:\/\//.test(url)) throw new Error("The URL must start with http:// or https://");
    await anchorRequest(url, null, "GET", "/health");

    let token = "";
    let user: Me | undefined;
    if (existing?.token && existing.url === url && (await p.yes("Keep the saved API token?"))) token = existing.token;
    else if (await p.yes("Sign in with email and password? (No = paste an API token)")) {
      const host = new URL(url).hostname;
      const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (url.startsWith("http://") && !local && !(await p.yes("This URL is not HTTPS, so your password travels unencrypted. Continue?", false)))
        throw new Error("Cancelled. Use the https:// address of your Anchor, or paste an API token instead.");
      const email = await p.ask("Email");
      ({ token, user } = await tokenFromLogin(url, email, await p.secret("Password (not stored)")));
    } else token = (await p.secret("API token")).trim();

    await step("Checking the API token", () => checkApiToken(url, token));
    saveConfig({ url, token });
    console.log(`\nConnected${user ? ` as ${user.name ?? user.email}` : ""}. Saved to ${CONFIG_PATH}\n`);

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
      await checkApiToken(config.url, config.token);
      check(true, "API token accepted");
    } catch (e) {
      check(false, e instanceof AnchorError ? e.message : String(e));
    }
  }
  for (const profile of claudeCodeProfiles()) console.log(`${isRegistered(profile.configFile) ? "ok  " : "--  "} Claude Code: ${profile.label}`);
  const desktop = desktopConfigPath();
  if (desktop) console.log(`${isRegistered(desktop) ? "ok  " : "--  "} Claude Desktop: ${desktop}`);
  process.exitCode = healthy ? 0 : 1;
}
