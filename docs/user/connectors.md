# Connectors

Connectors are MCP servers you add once in T3 Code. Every provider (Codex,
Claude, Cursor, Grok, OpenCode, and Antigravity) gets their tools in new
sessions, so you don't have to configure each one separately.

## Connect one in a click

Open **Settings → Connectors** and choose **Connect** on a tile. T3 Code adds
the connector, opens the service's sign-in page if it needs one, and checks
that it works. The tile then shows **Connected** with the number of tools the
agent gets.

- Services like Linear, Notion, Sentry, and Stripe sign in with your account
  in the browser. When the page says you're connected, come back to T3 Code.
- GitHub, Render, and Apify ask for a token instead. The dialog links to the
  page where you create one.
- Local servers (Playwright, Filesystem, Memory, and others) run on the
  environment's machine through `npx` or `uvx`. If that machine doesn't have
  Node.js or uv, T3 Code tells you what to install. The first check can take a
  minute while the package downloads.

Search to filter the gallery. Searches also list community servers from the
official MCP Registry; T3 Code doesn't review those, so check a server's
source before adding it.

Connectors live on the environment, so a connector added on a remote machine
runs on that machine and every device connected to it sees the same list.

## Add your own

Choose **Add connector** for any other server. A connector is either:

- **Command**: a local MCP server T3 Code starts for the agent. Values marked
  secret stay on the environment's server and aren't shown again.
- **URL**: a remote MCP server reached over HTTP, with a bearer token or OAuth
  sign-in.

Choose **Test** on a connector to check it again. If a service signs you out,
the connector shows **Reconnect**.

To limit a connector to some providers, choose them in its settings. An ACP
agent (Cursor, Grok, Antigravity) that doesn't support remote MCP servers
skips URL connectors.

## Servers set up in Codex, Claude, or OpenCode

Agents in T3 Code use only the connectors on this page, not MCP servers
configured in each agent's own settings. If Codex (`~/.codex/config.toml`) or
Claude Code (`~/.claude.json`, a project's `.mcp.json`) has servers, the page
offers **Import all**; their environment variables and headers move into the
environment's secret store. You can also import them one at a time.

To keep each agent's own servers as well, turn on **Also load MCP servers from
each agent's own config**. Cursor, Grok, and Antigravity always load their own
MCP configuration in addition to your connectors.

## Turn connectors off for a thread

Use **Connectors** in the thread's menu to turn a connector off for just that
thread, and the same menu to turn it back on. The change applies from the
thread's next message. Adding, editing, or connecting a connector in Settings
applies to sessions that start afterwards.
