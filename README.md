# anchor-notes-mcp

An [MCP](https://modelcontextprotocol.io) server for [Anchor](https://github.com/ZhFahim/anchor), the self-hosted notes app. It lets Claude (Claude Code, Claude Desktop, or any local MCP client) search, read, create and edit your notes.

Notes go in and out as **markdown**, converted with Anchor's own import/export code. Headings, bold, italic, underline, strike, highlights, links, lists, checklists, quotes and code blocks all survive the round trip, so Claude's edits show up properly formatted in the app.

## Install

You need Node.js 20 or newer and a running Anchor instance.

```bash
npx anchor-notes-mcp setup
```

The setup does four things:

1. Asks for your Anchor URL.
2. Signs you in with your email and password and fetches your API token, creating one if you don't have it yet. You can paste a token instead. Your password is never stored.
3. Saves the URL and token to `~/.config/anchor-notes-mcp/config.json`.
4. Offers to register the server in each Claude Code profile and in Claude Desktop it finds.

Restart Claude Desktop afterwards. To check everything:

```bash
npx anchor-notes-mcp doctor
```

<details>
<summary>Manual setup</summary>

Any MCP client can start it with `npx -y anchor-notes-mcp`. On Windows, use `cmd /c npx -y anchor-notes-mcp`. It reads the config file, or the `ANCHOR_URL` and `ANCHOR_TOKEN` environment variables, which take precedence.

```bash
claude mcp add --scope user anchor -e ANCHOR_URL=https://notes.example.com -e ANCHOR_TOKEN=... -- npx -y anchor-notes-mcp
```

</details>

## Tools

| Tool | What it does |
|---|---|
| `search_notes` | List or search notes (title and a snippet) |
| `get_note` | Read a note as markdown, with its version |
| `create_note` | Create a note from markdown |
| `update_note` | Replace a note's title or content, tags, pin and archive state |
| `append_to_note` | Add markdown at the end of a note |
| `trash_note` | Move a note to the trash |
| `list_tags` / `create_tag` | Manage tags |

**Safe edits:**

- `update_note` sends the version Claude read. If you changed the note in the app in the meantime, Anchor rejects the write, nothing is lost, and Claude is told to re-read and retry.
- `append_to_note` never rewrites the existing content.

**Attachments:** attachments live outside the note text in Anchor. Edits never touch them, but this server does not read or upload them yet.

## Development

```bash
npm install
npm test          # Anchor's markdown round-trip fixtures, both directions
npm run build     # dist/cli.js, a single self-contained file
npm run smoke     # end-to-end against your configured instance; creates and trashes a test note (--keep to inspect it)
node dist/cli.js setup --local   # register this checkout instead of the npm package
```

## License

AGPL-3.0. The markdown conversion in `src/vendor/anchor/` and the test fixtures are copied from [Anchor](https://github.com/ZhFahim/anchor), which is AGPL-3.0; each file names the commit it came from.
