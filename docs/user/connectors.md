# Connectors

Connectors are MCP servers you add once in T3 Code. Every provider (Codex,
Claude, Cursor, Grok, OpenCode, and Antigravity) gets their tools in new
sessions, so you don't have to configure each one separately.

## Add a connector

Open **Settings → Connectors** and choose **Add connector**. A connector is
either:

- **Command**: a local MCP server T3 Code starts for the agent, such as
  `npx -y @modelcontextprotocol/server-github`. Add environment variables it
  needs. Values marked secret stay on the environment's server and aren't
  shown again.
- **URL**: a remote MCP server reached over HTTP. Choose **Bearer token** if
  the service gave you a token, or **OAuth** to sign in with your account.

Connectors live on the environment, so a connector added on a remote machine
runs on that machine and every device connected to it sees the same list.

For OAuth connectors, choose **Connect** after adding one. A browser window
opens on the service's sign-in page; when it says you're connected, come back
to T3 Code. T3 Code refreshes the sign-in when a session starts. If a service
signs you out, the connector shows **Reconnect**.

To limit a connector to some providers, choose them in its settings. Command
and URL connectors work with every provider, except that an ACP agent (Cursor,
Grok, Antigravity) that doesn't support remote MCP servers skips URL
connectors.

## Import from Codex or Claude

**Settings → Connectors** lists MCP servers already set up in Codex
(`~/.codex/config.toml`) and Claude Code (`~/.claude.json` and a project's
`.mcp.json`). Choose **Import** to copy one into T3 Code. Imported environment
variables and headers are saved as secrets. Codex and Claude keep loading
their own configuration too, so a server set up in both places can appear
twice until you remove one copy.

## Turn connectors off for a thread

Use **Connectors** in the thread's menu to turn a connector off for just that
thread, and the same menu to turn it back on. The change applies from the
thread's next message. Adding, editing, or connecting a connector in Settings
applies to sessions that start afterwards.
