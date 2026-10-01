import { McpCatalogEntry } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { mapRegistryResponse, registrySearchUrl } from "./McpRegistry.ts";

const isCatalogEntry = Schema.is(McpCatalogEntry);
const active = { "io.modelcontextprotocol.registry/official": { status: "active" } };

const response = {
  servers: [
    {
      server: {
        name: "app.linear/linear",
        title: "Linear",
        description: "Issues",
        websiteUrl: "https://linear.app",
        remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }],
      },
      _meta: active,
    },
    {
      server: {
        name: "com.example/keyed",
        description: "Needs a key",
        remotes: [
          {
            type: "streamable-http",
            url: "https://keyed.example.com/mcp",
            headers: [
              {
                name: "Authorization",
                value: "Bearer {api_key}",
                isRequired: true,
                isSecret: true,
                description: "Your API key",
              },
              { name: "X-Optional", isRequired: false },
            ],
          },
        ],
      },
      _meta: active,
    },
    {
      server: {
        name: "io.github.someone/pg-tools",
        description: "Postgres",
        packages: [
          { registryType: "oci", identifier: "ghcr.io/someone/pg", transport: { type: "stdio" } },
          {
            registryType: "npm",
            identifier: "pg-tools-mcp",
            version: "1.2.3",
            transport: { type: "stdio" },
            environmentVariables: [
              { name: "DATABASE_URL", isRequired: true, isSecret: true, description: "Connection" },
              { name: "LOG_LEVEL", default: "info" },
            ],
            packageArguments: [
              { type: "named", name: "--read-only", value: "true" },
              { type: "positional", valueHint: "schema", isRequired: true },
            ],
          },
        ],
      },
      _meta: active,
    },
    {
      server: {
        name: "io.github.someone/py",
        packages: [
          {
            registryType: "pypi",
            identifier: "py-mcp",
            version: "0.1.0",
            transport: { type: "stdio" },
          },
        ],
      },
      _meta: active,
    },
    {
      server: {
        name: "io.github.someone/docker-only",
        packages: [
          {
            registryType: "oci",
            identifier: "ghcr.io/someone/tool:1",
            transport: { type: "stdio" },
            environmentVariables: [{ name: "TOKEN", isRequired: true, isSecret: true }],
          },
        ],
      },
      _meta: active,
    },
    // Unrunnable or retired entries are left out.
    {
      server: {
        name: "com.example/sse-only",
        remotes: [{ type: "sse", url: "https://x.test/sse" }],
      },
      _meta: active,
    },
    {
      server: {
        name: "com.example/templated",
        remotes: [{ type: "streamable-http", url: "https://{tenant}.example.com/mcp" }],
      },
      _meta: active,
    },
    {
      server: {
        name: "com.example/old",
        remotes: [{ type: "streamable-http", url: "https://old.example.com/mcp" }],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "deprecated" } },
    },
  ],
  metadata: { nextCursor: "next-page", count: 8 },
};

describe("mapRegistryResponse", () => {
  const result = mapRegistryResponse(response);
  const byId = Object.fromEntries(result.entries.map((entry) => [entry.id, entry]));

  it("keeps runnable, active servers as valid catalog entries", () => {
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "registry:app.linear/linear",
      "registry:com.example/keyed",
      "registry:io.github.someone/pg-tools",
      "registry:io.github.someone/py",
      "registry:io.github.someone/docker-only",
    ]);
    expect(result.nextCursor).toBe("next-page");
    for (const entry of result.entries) {
      expect(isCatalogEntry(entry)).toBe(true);
      expect(entry.source).toBe("registry");
      expect(entry.connector.catalogId).toBe(entry.id);
    }
  });

  it("maps remotes to HTTP connectors with required headers as fields", () => {
    expect(byId["registry:app.linear/linear"]).toMatchObject({
      name: "Linear",
      iconDomain: "linear.app",
      fields: [],
      connector: { transport: { type: "http", url: "https://mcp.linear.app/mcp" } },
    });
    expect(byId["registry:com.example/keyed"]?.fields).toEqual([
      {
        id: "header:Authorization",
        label: "Authorization",
        description: "Your API key",
        secret: true,
        required: true,
        target: { type: "header", name: "Authorization", format: "Bearer {value}" },
      },
    ]);
  });

  it("maps packages to npx, uvx, and docker with required env vars and args as fields", () => {
    const npm = byId["registry:io.github.someone/pg-tools"];
    expect(npm?.runtime).toBe("npx");
    expect(npm?.connector.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "pg-tools-mcp@1.2.3", "--read-only", "true"],
      env: [],
    });
    expect(npm?.fields.map((field) => [field.id, field.target])).toEqual([
      ["env:DATABASE_URL", { type: "env", name: "DATABASE_URL" }],
      ["arg:1", { type: "arg" }],
    ]);
    expect(byId["registry:io.github.someone/py"]?.connector.transport).toMatchObject({
      command: "uvx",
      args: ["py-mcp@0.1.0"],
    });
    expect(byId["registry:io.github.someone/docker-only"]?.connector.transport).toMatchObject({
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "TOKEN", "ghcr.io/someone/tool:1"],
    });
  });
});

describe("registrySearchUrl", () => {
  it("asks for the latest version of each server", () => {
    const url = new URL(registrySearchUrl(" notion ", "c1"));
    expect(url.origin + url.pathname).toBe("https://registry.modelcontextprotocol.io/v0.1/servers");
    expect(url.searchParams.get("search")).toBe("notion");
    expect(url.searchParams.get("version")).toBe("latest");
    expect(url.searchParams.get("cursor")).toBe("c1");
  });
});
