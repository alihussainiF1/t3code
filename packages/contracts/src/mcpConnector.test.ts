import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { McpConnectorConfig, McpConnectorId } from "./mcpConnector.ts";
import { ServerSettings } from "./settings.ts";

describe("McpConnectorId", () => {
  it("accepts only names every provider can use as an MCP server key", () => {
    const isId = Schema.is(McpConnectorId);
    expect(isId("github")).toBe(true);
    expect(isId("my_server-2")).toBe(true);
    for (const bad of ["", "-lead", "has space", "dot.ted", "a/b", "x".repeat(65)]) {
      expect(isId(bad)).toBe(false);
    }
  });
});

describe("McpConnectorConfig", () => {
  it("fills defaults for a minimal hand-written entry", () => {
    expect(
      Schema.decodeSync(McpConnectorConfig)({
        name: "Remote",
        transport: { type: "http", url: "https://example.com/mcp" },
      }),
    ).toEqual({
      name: "Remote",
      enabled: true,
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: [],
        auth: { type: "none" },
      },
    });
  });

  it("defaults to no connectors in settings", () => {
    expect(Schema.decodeSync(ServerSettings)({}).mcpConnectors).toEqual({});
  });
});
