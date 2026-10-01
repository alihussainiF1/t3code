import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  applyMcpCatalogFields,
  BUILT_IN_MCP_CATALOG,
  MCP_CATALOG_VERIFIED_AT,
  McpCatalogEntry,
} from "./mcpConnectorCatalog.ts";

const isCatalogEntry = Schema.is(McpCatalogEntry);
const byId = (id: string) => BUILT_IN_MCP_CATALOG.find((entry) => entry.id === id)!;

describe("BUILT_IN_MCP_CATALOG", () => {
  it("records when its endpoints were verified", () => {
    expect(MCP_CATALOG_VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("holds schema-valid entries with unique ids that link back to their connector", () => {
    const ids = new Set<string>();
    for (const entry of BUILT_IN_MCP_CATALOG) {
      expect(isCatalogEntry(entry), entry.id).toBe(true);
      expect(entry.id).toMatch(/^builtin:[a-z0-9-]+$/);
      expect(ids.has(entry.id), entry.id).toBe(false);
      ids.add(entry.id);
      expect(entry.source).toBe("built-in");
      expect(entry.connector.catalogId).toBe(entry.id);
      expect(entry.connector.name).toBe(entry.name);
      expect(entry.iconDomain).toMatch(/^[a-z0-9.-]+\.[a-z]+$/);
    }
  });

  it("uses https endpoints and the launcher each local entry names", () => {
    for (const entry of BUILT_IN_MCP_CATALOG) {
      const transport = entry.connector.transport;
      if (transport.type === "http") {
        expect(new URL(transport.url).protocol, entry.id).toBe("https:");
        expect(entry.runtime).toBeUndefined();
        // Token entries say where to get the token.
        if (transport.auth.type === "bearer") expect(entry.tokenUrl, entry.id).toMatch(/^https:/);
      } else {
        expect(transport.command, entry.id).toBe(entry.runtime);
      }
    }
  });
});

describe("applyMcpCatalogFields", () => {
  it("returns the connector unchanged when an entry has no fields", () => {
    expect(applyMcpCatalogFields(byId("builtin:linear"), {})).toEqual({
      ok: true,
      config: byId("builtin:linear").connector,
    });
  });

  it("puts a token where the entry says and requires required fields", () => {
    const github = byId("builtin:github");
    expect(applyMcpCatalogFields(github, { token: "  " })).toEqual({
      ok: false,
      missing: "Personal access token",
    });
    const applied = applyMcpCatalogFields(github, { token: "ghp_x" });
    expect(applied.ok && applied.config.transport).toMatchObject({
      type: "http",
      auth: { type: "bearer", token: "ghp_x" },
    });
  });

  it("appends arguments, env vars, and formatted headers", () => {
    const filesystem = applyMcpCatalogFields(byId("builtin:filesystem"), { directory: "/srv" });
    expect(filesystem.ok && filesystem.config.transport).toMatchObject({
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv"],
    });
    const custom: McpCatalogEntry = {
      ...byId("builtin:linear"),
      fields: [
        {
          id: "key",
          label: "Key",
          secret: true,
          required: true,
          target: { type: "header", name: "Authorization", format: "Bearer {value}" },
        },
      ],
    };
    const withHeader = applyMcpCatalogFields(custom, { key: "abc" });
    expect(withHeader.ok && withHeader.config.transport).toMatchObject({
      headers: [{ name: "Authorization", value: "Bearer abc", secret: true }],
    });
  });
});
