# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue.

## What this package does with your data

- **Your API token** is stored in `~/.config/anchor-notes-mcp/config.json`, owner-readable only on macOS/Linux. It is never written into Claude's config files and never sent anywhere except your Anchor server.
- **Your password** is used once during `setup` to fetch your API token, and is never stored.
- **Network traffic** goes only to the Anchor URL you configure.
- **Note content** is passed to the AI model you connect. Treat notes others share with you as untrusted text, since they can contain instructions aimed at the model.
- **Notes are never deleted for good:** the server can only move them to the trash.
- **Permanent deletions** are limited to deleting an attachment or a tag, and stopping a share. Those tools carry MCP's `destructiveHint`, so clients can ask before running them.
- **Local files:**
  - `add_attachment` reads only the path it is given, and only image or audio files, the types Anchor accepts.
  - `get_attachment` and `export_notes` write new files only, never overwriting. File names coming from the server are reduced to a bare name, so they can't point outside the chosen folder.
