import type { McpConnectorConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  REDACTED_SECRET,
  buildConnectorConfig,
  connectorFormFromConfig,
  connectorIdFromName,
  connectorStatus,
  newKeyValueRow,
  parseArgsText,
  setRowSecret,
} from "./ConnectorsSettings.logic";

describe("connectorIdFromName", () => {
  it("slugs the name and keeps it unique", () => {
    expect(connectorIdFromName("My GitHub Server!", [])).toBe("my-github-server");
    expect(connectorIdFromName("Linear", ["linear", "linear-2"])).toBe("linear-3");
  });

  it("falls back for empty slugs and avoids the built-in server name", () => {
    expect(connectorIdFromName("✨✨", [])).toBe("connector");
    expect(connectorIdFromName("T3 Code", [])).toBe("t3-code-mcp");
    expect(connectorIdFromName("t3-code", ["t3-code-mcp"])).toBe("t3-code-mcp-2");
  });

  it("stays within the id length limit", () => {
    const id = connectorIdFromName("x".repeat(80), ["x".repeat(64)]);
    expect(id).toHaveLength(64);
    expect(id.endsWith("-2")).toBe(true);
  });
});

describe("parseArgsText", () => {
  it("takes one argument per line and drops blank lines", () => {
    expect(parseArgsText("-y\n @modelcontextprotocol/server-github \n\n")).toEqual([
      "-y",
      "@modelcontextprotocol/server-github",
    ]);
  });
});

describe("setRowSecret", () => {
  it("clears a saved secret when it stops being secret", () => {
    const row = { ...newKeyValueRow(), name: "TOKEN", value: REDACTED_SECRET };
    expect(setRowSecret(row, false).value).toBe("");
    expect(setRowSecret({ ...row, value: "typed" }, false).value).toBe("typed");
  });
});

describe("buildConnectorConfig", () => {
  const oauthConnector: McpConnectorConfig = {
    name: "Linear",
    enabled: false,
    transport: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: [{ name: "X-Key", value: REDACTED_SECRET, secret: true }],
      auth: { type: "oauth", scopes: "", clientId: "", connectedAt: "2026-09-01T00:00:00.000Z" },
    },
  };

  it("round-trips an edited connector, keeping secrets redacted and server-owned state", () => {
    const form = connectorFormFromConfig(oauthConnector);
    const result = buildConnectorConfig({ ...form, name: "Linear app" }, oauthConnector);
    expect(result).toEqual({
      ok: true,
      config: { ...oauthConnector, name: "Linear app" },
    });
  });

  it("builds stdio connectors and drops unnamed env rows", () => {
    const form = {
      ...connectorFormFromConfig(null),
      name: " GitHub ",
      command: "npx",
      argsText: "-y\nserver-github",
      env: [
        { ...newKeyValueRow(), name: "GITHUB_TOKEN", value: "abc" },
        { ...newKeyValueRow(), name: " ", value: "ignored" },
      ],
      providers: [],
    };
    expect(buildConnectorConfig(form, null)).toEqual({
      ok: true,
      config: {
        name: "GitHub",
        enabled: true,
        providers: [],
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "server-github"],
          env: [{ name: "GITHUB_TOKEN", value: "abc", secret: true }],
        },
      },
    });
  });

  it("rejects missing names, commands, and non-http URLs", () => {
    const blank = connectorFormFromConfig(null);
    expect(buildConnectorConfig(blank, null).ok).toBe(false);
    expect(buildConnectorConfig({ ...blank, name: "x" }, null).ok).toBe(false);
    expect(
      buildConnectorConfig({ ...blank, name: "x", transport: "http", url: "ftp://a" }, null).ok,
    ).toBe(false);
  });
});

describe("connectorStatus", () => {
  it("reports OAuth connection and missing bearer tokens", () => {
    const http = (auth: Extract<McpConnectorConfig["transport"], { type: "http" }>["auth"]) =>
      ({
        name: "x",
        enabled: true,
        transport: { type: "http", url: "https://x", headers: [], auth },
      }) satisfies McpConnectorConfig;
    expect(connectorStatus(http({ type: "bearer", token: "" }))).toEqual({
      kind: "missing-token",
    });
    expect(
      connectorStatus(http({ type: "oauth", scopes: "", clientId: "", connectedAt: null })),
    ).toEqual({ kind: "oauth-disconnected" });
  });
});
