import { describe, expect, it } from "vite-plus/test";

import {
  connectorIdFromName,
  expandEnvironmentReferences,
  parseClaudeMcpServers,
  parseCodexMcpServers,
  redactDiscoveredConnector,
} from "./McpConnectorDiscovery.ts";

const MARKER = "••••••";

describe("parseCodexMcpServers", () => {
  it("reads stdio and HTTP servers, resolving env-var indirection from the server's environment", () => {
    const toml = `
model = "gpt-5"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env_vars = ["GITHUB_TOKEN", "MISSING_VAR"]
cwd = "/tmp"

[mcp_servers.github.env]
LOG = "debug"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
bearer_token_env_var = "LINEAR_TOKEN"
http_headers = { "X-Team" = "eng" }

[mcp_servers.notion]
url = "https://mcp.notion.com/mcp"
scopes = ["read"]
enabled = false
`;
    const servers = parseCodexMcpServers(toml, {
      path: "/home/u/.codex/config.toml",
      environment: { GITHUB_TOKEN: "ghp", LINEAR_TOKEN: "lin" },
    });
    expect(servers.map((server) => server.name)).toEqual(["github", "linear", "notion"]);
    expect(servers[0]?.connector).toEqual({
      name: "github",
      enabled: true,
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: [
          { name: "LOG", value: "debug", secret: true },
          { name: "GITHUB_TOKEN", value: "ghp", secret: true },
        ],
      },
    });
    expect(servers[0]?.note).toContain("MISSING_VAR");
    expect(servers[0]?.note).toContain("working directory");
    expect(servers[1]?.connector?.transport).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: [{ name: "X-Team", value: "eng", secret: true }],
      auth: { type: "bearer", token: "lin" },
    });
    expect(servers[2]?.connector).toMatchObject({
      enabled: false,
      transport: { auth: { type: "oauth", scopes: "read" } },
    });
  });

  it("returns nothing for unreadable TOML", () => {
    expect(parseCodexMcpServers("[[[", { path: "x", environment: {} })).toEqual([]);
  });
});

describe("parseClaudeMcpServers", () => {
  it("reads Claude's mcpServers, expanding ${VAR} references", () => {
    const servers = parseClaudeMcpServers(
      {
        fs: {
          command: "npx",
          args: ["server-fs", "${HOME}/code"],
          env: { KEY: "${API_KEY:-none}" },
        },
        sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
        keyed: {
          type: "http",
          url: "https://x.dev/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
        legacy: { type: "sse", url: "https://old.dev/sse" },
      },
      { source: "claude-user", path: "/home/u/.claude.json", environment: { HOME: "/home/u" } },
    );
    expect(servers[0]?.connector?.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["server-fs", "/home/u/code"],
      env: [{ name: "KEY", value: "none", secret: true }],
    });
    expect(servers[1]?.connector?.transport).toMatchObject({ auth: { type: "oauth" } });
    expect(servers[2]?.connector?.transport).toMatchObject({ auth: { type: "none" } });
    expect(servers[2]?.note).toContain("TOKEN");
    expect(servers[3]?.connector).toBeNull();
  });
});

describe("helpers", () => {
  it("expands defaults and reports missing variables", () => {
    expect(expandEnvironmentReferences("${A}-${B:-b}-${C}", { A: "a" })).toEqual({
      value: "a-b-",
      missing: ["C"],
    });
  });

  it("derives unique, provider-safe connector ids", () => {
    expect(connectorIdFromName("GitHub Enterprise!", new Set())).toBe("github-enterprise");
    expect(connectorIdFromName("github", new Set(["github", "github-2"]))).toBe("github-3");
    expect(connectorIdFromName("t3-code", new Set())).toBe("t3-code-mcp");
    expect(connectorIdFromName("???", new Set())).toBe("connector");
  });

  it("blanks every value in the discovery view", () => {
    const [server] = parseClaudeMcpServers(
      { fs: { command: "x", env: { KEY: "v", EMPTY: "" } } },
      { source: "mcp-json", path: ".mcp.json", environment: {} },
    );
    const redacted = redactDiscoveredConnector(server!.connector!);
    expect(redacted.transport.type === "stdio" && redacted.transport.env).toEqual([
      { name: "KEY", value: MARKER, secret: true },
      { name: "EMPTY", value: "", secret: false },
    ]);
  });
});
