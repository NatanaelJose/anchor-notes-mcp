import { startServer } from "./server";
import { doctor, setup } from "./setup";
import { VERSION } from "./version";

const [command, ...flags] = process.argv.slice(2);

const HELP = `anchor-notes-mcp ${VERSION} — MCP server for Anchor notes

  anchor-notes-mcp            run the MCP server (stdio); Claude starts this for you
  anchor-notes-mcp setup      connect to your Anchor and register it in Claude Code / Claude Desktop
                              --local  register this checkout (node dist/cli.js) instead of npx
  anchor-notes-mcp doctor     check config, server, token and registrations
`;

const main = async () => {
  if (!command) return startServer();
  if (command === "setup") return setup(flags.includes("--local"));
  if (command === "doctor") return doctor();
  if (command === "--version" || command === "-v") return console.log(VERSION);
  console.log(HELP);
};

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1; // not process.exit(): on Windows it can abort while stdin handles are closing
});
