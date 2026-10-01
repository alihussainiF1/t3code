import { type McpConnectorConfig, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  codexConfiguredMcpServerNames,
  filterAcpMcpServersByCapabilities,
  resolveMcpConnectors,
  type ResolvedMcpConnector,
  toAcpMcpServers,
  toClaudeMcpServers,
  toCodexMcpConfig,
  toCodexMcpDisableArgs,
  toOpenCodeMcpConfigs,
} from "./McpConnectorTranslators.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const stdio = (overrides: Partial<McpConnectorConfig> = {}): McpConnectorConfig => ({
  name: "GitHub",
  enabled: true,
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: [
      { name: "GITHUB_TOKEN", value: "ghp_x", secret: true },
      { name: "LOG", value: "info", secret: false },
    ],
  },
  ...overrides,
});

const http = (auth: Extract<McpConnectorConfig["transport"], { type: "http" }>["auth"]) =>
  ({
    name: "Linear",
    enabled: true,
    transport: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: [
        { name: "X-Plain", value: "p", secret: false },
        { name: "X-Key", value: "k", secret: true },
        { name: "Authorization", value: "Bearer stale", secret: true },
      ],
      auth,
    },
  }) satisfies McpConnectorConfig;

describe("resolveMcpConnectors", () => {
  it("applies global enablement, thread opt-outs, and provider allowlists", () => {
    const result = resolveMcpConnectors({
      connectors: {
        github: stdio(),
        off: stdio({ enabled: false }),
        threadOff: stdio(),
        claudeOnly: stdio({ providers: [claude] }),
        none: stdio({ providers: [] }),
      },
      disabledForThread: ["threadOff"],
      provider: codex,
      oauthAccessTokens: {},
    });
    expect(result.connectors.map((connector) => connector.id)).toEqual(["github"]);
    expect(result.skipped).toEqual([]);
  });

  it("leaves out OAuth connectors without a token and the reserved t3-code id", () => {
    const result = resolveMcpConnectors({
      connectors: {
        linear: http({ type: "oauth", scopes: "", clientId: "", connectedAt: null }),
        "t3-code": stdio(),
      },
      disabledForThread: [],
      provider: codex,
      oauthAccessTokens: {},
    });
    expect(result.connectors).toEqual([]);
    expect(result.skipped.map((skip) => skip.id)).toEqual(["linear", "t3-code"]);
  });

  it("turns OAuth and bearer auth into a bearer token that replaces any Authorization header", () => {
    const result = resolveMcpConnectors({
      connectors: { linear: http({ type: "oauth", scopes: "", clientId: "", connectedAt: "x" }) },
      disabledForThread: [],
      provider: codex,
      oauthAccessTokens: { linear: "access" },
    });
    const [connector] = result.connectors;
    expect(connector?.type === "http" && connector.bearerToken).toBe("access");
    expect(connector?.type === "http" && connector.headers.map((header) => header.name)).toEqual([
      "X-Plain",
      "X-Key",
    ]);
  });
});

const resolved: ReadonlyArray<ResolvedMcpConnector> = resolveMcpConnectors({
  connectors: { github: stdio(), linear: http({ type: "bearer", token: "s3cr3t" }) },
  disabledForThread: [],
  provider: codex,
  oauthAccessTokens: {},
}).connectors;

describe("toCodexMcpConfig", () => {
  it("emits TOML overrides and keeps every secret off argv", () => {
    const config = toCodexMcpConfig(resolved);
    expect(config.args).toEqual([
      "-c",
      'mcp_servers.github.command="npx"',
      "-c",
      'mcp_servers.github.args=["-y", "@modelcontextprotocol/server-github"]',
      "-c",
      'mcp_servers.github.env={ LOG = "info" }',
      "-c",
      'mcp_servers.github.env_vars=["GITHUB_TOKEN"]',
      "-c",
      'mcp_servers.linear.url="https://mcp.linear.app/mcp"',
      "-c",
      'mcp_servers.linear.bearer_token_env_var="T3_MCP_C1_BEARER"',
      "-c",
      'mcp_servers.linear.http_headers={ X-Plain = "p" }',
      "-c",
      'mcp_servers.linear.env_http_headers={ X-Key = "T3_MCP_C1_HEADER_0" }',
    ]);
    expect(config.env).toEqual({
      GITHUB_TOKEN: "ghp_x",
      T3_MCP_C1_BEARER: "s3cr3t",
      T3_MCP_C1_HEADER_0: "k",
    });
    for (const secret of ["ghp_x", "s3cr3t", '"k"']) {
      expect(config.args.join(" ")).not.toContain(secret);
    }
  });

  it("refuses to give two connectors different values for one forwarded secret", () => {
    const twice = resolveMcpConnectors({
      connectors: {
        a: stdio(),
        b: stdio({
          transport: {
            type: "stdio",
            command: "x",
            args: [],
            env: [{ name: "GITHUB_TOKEN", value: "other", secret: true }],
          },
        }),
      },
      disabledForThread: [],
      provider: codex,
      oauthAccessTokens: {},
    }).connectors;
    const config = toCodexMcpConfig(twice);
    expect(config.env.GITHUB_TOKEN).toBe("ghp_x");
    expect(config.warnings).toHaveLength(1);
    expect(config.args).not.toContain('mcp_servers.b.env_vars=["GITHUB_TOKEN"]');
  });

  it("quotes keys TOML cannot take bare", () => {
    const config = toCodexMcpConfig([
      {
        id: "x" as never,
        name: "x",
        type: "stdio",
        command: "c",
        args: [],
        env: [{ name: "A.B", value: "v", secret: false }],
      },
    ]);
    expect(config.args).toContain('mcp_servers.x.env={ "A.B" = "v" }');
  });
});

describe("toClaudeMcpServers", () => {
  it("references secrets through ${VAR} expansion", () => {
    const { servers, env } = toClaudeMcpServers(resolved);
    expect(servers.github).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${T3_MCP_C0_ENV_0}", LOG: "info" },
    });
    expect(servers.linear).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: {
        "X-Plain": "p",
        "X-Key": "${T3_MCP_C1_HEADER_1}",
        Authorization: "${T3_MCP_C1_HEADER_2}",
      },
    });
    expect(env).toEqual({
      T3_MCP_C0_ENV_0: "ghp_x",
      T3_MCP_C1_HEADER_1: "k",
      T3_MCP_C1_HEADER_2: "Bearer s3cr3t",
    });
  });
});

describe("ACP", () => {
  it("maps connectors to ACP McpServer entries", () => {
    expect(toAcpMcpServers(resolved)).toEqual([
      {
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: [
          { name: "GITHUB_TOKEN", value: "ghp_x" },
          { name: "LOG", value: "info" },
        ],
      },
      {
        type: "http",
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        headers: [
          { name: "X-Plain", value: "p" },
          { name: "X-Key", value: "k" },
          { name: "Authorization", value: "Bearer s3cr3t" },
        ],
      },
    ]);
  });

  it("drops HTTP servers for agents that do not advertise HTTP", () => {
    const servers = toAcpMcpServers(resolved);
    const withoutHttp = filterAcpMcpServersByCapabilities(servers, { http: false });
    expect(withoutHttp.supported.map((server) => server.name)).toEqual(["github"]);
    expect(withoutHttp.unsupported.map((server) => server.name)).toEqual(["linear"]);
    expect(filterAcpMcpServersByCapabilities(servers, undefined).supported).toHaveLength(1);
    expect(filterAcpMcpServersByCapabilities(servers, { http: true }).supported).toHaveLength(2);
  });
});

describe("toOpenCodeMcpConfigs", () => {
  it("maps stdio to local and http to remote without OpenCode's own OAuth", () => {
    expect(toOpenCodeMcpConfigs(resolved)).toEqual([
      {
        name: "github",
        config: {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-github"],
          environment: { GITHUB_TOKEN: "ghp_x", LOG: "info" },
          enabled: true,
        },
      },
      {
        name: "linear",
        config: {
          type: "remote",
          url: "https://mcp.linear.app/mcp",
          headers: { "X-Plain": "p", "X-Key": "k", Authorization: "Bearer s3cr3t" },
          oauth: false,
          enabled: true,
        },
      },
    ]);
  });
});

describe("Codex exclusivity", () => {
  it("lists the servers a Codex config.toml defines", () => {
    expect(
      codexConfiguredMcpServerNames(
        '[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n\n[mcp_servers."my.local"]\ncommand = "x"\n',
      ),
    ).toEqual(["linear", "my.local"]);
    expect(codexConfiguredMcpServerNames("not = [valid")).toEqual([]);
    expect(codexConfiguredMcpServerNames('model = "gpt-5"')).toEqual([]);
  });

  it("turns off every configured server T3 does not set, by name", () => {
    expect(
      toCodexMcpDisableArgs(
        ["linear", "sentry", "t3-code", "my.local", "sentry"],
        ["t3-code", "linear"],
      ),
    ).toEqual({
      args: ["-c", "mcp_servers.sentry.enabled=false"],
      unaddressable: ["my.local"],
    });
  });
});
