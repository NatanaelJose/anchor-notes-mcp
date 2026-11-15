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

| Area | Tools | What they do |
|---|---|---|
| Notes | `search_notes` | List or search active, archived or trashed notes; results include each note's markdown (first 1,500 chars) |
| | `get_note`, `create_note`, `update_note`, `append_to_note` | Read and write notes as markdown, including background color and reminders |
| | `trash_note`, `restore_note` | Move to and back from the trash |
| | `bulk_update_notes` | Trash, archive, pin, unpin or tag up to 200 notes at once |
| History | `list_note_versions`, `get_note_version`, `restore_note_version` | Browse and restore earlier versions; every edit is kept |
| Attachments | `list_attachments`, `get_attachment`, `add_attachment`, `delete_attachment` | Images are shown to Claude directly; audio and big files are saved to disk; upload images or audio from a local file |
| Sharing | `find_users`, `list_shares`, `share_note`, `unshare_note` | Share notes with other users on your server as viewer or editor |
| Tags | `list_tags`, `create_tag`, `update_tag`, `delete_tag` | Manage tags |
| Backup | `export_notes` | Save a zip of all notes, as markdown or in Anchor's own format |

**Safe edits:**

- `update_note` sends the version Claude read. If you changed the note in the app in the meantime, Anchor rejects the write, nothing is lost, and Claude is told to re-read and retry.
- `append_to_note` never rewrites the existing content.
- Every edit lands in the note's history, so a bad one can be undone with `restore_note_version`.
- Notes are never deleted for good.
- Tools that do delete something (an attachment, a tag, a share) are marked destructive, so your client can ask before running them.
- Downloads never overwrite existing files.

## Security

- Your API token stays in the local config file and only goes to your Anchor server.
- Your password is never stored.
- The server can't permanently delete notes, only move them to the trash.
- `add_attachment` only uploads image and audio files; `get_attachment` and `export_notes` only write new files.
- `npx -y anchor-notes-mcp` always runs the latest release. To pin a version, use `anchor-notes-mcp@0.2.0` in your Claude config.

See [SECURITY.md](SECURITY.md) for details and how to report a vulnerability.

## Development

```bash
npm install
npm test          # markdown round-trip fixtures from Anchor + every tool against a fake Anchor
npm run build     # dist/cli.js, a single self-contained file
npm run smoke     # end-to-end against your configured instance; creates and trashes a test note (--keep to inspect it)
node dist/cli.js setup --local   # register this checkout instead of the npm package
```

## License

AGPL-3.0. The markdown conversion in `src/vendor/anchor/` and the test fixtures are copied from [Anchor](https://github.com/ZhFahim/anchor), which is AGPL-3.0; each file names the commit it came from.
