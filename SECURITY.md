# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue.

## What this package does with your data

- **Your API token** is stored in `~/.config/anchor-notes-mcp/config.json`, owner-readable only on macOS/Linux. It is never written into Claude's config files and never sent anywhere except your Anchor server.
- **Your password** is used once during `setup` to fetch your API token, and is never stored.
- **Network traffic** goes only to the Anchor URL you configure.
- **Note content** is passed to the AI model you connect. Treat notes others share with you as untrusted text, since they can contain instructions aimed at the model.
- **Deletion** is never permanent: the server can only move notes to the trash.
