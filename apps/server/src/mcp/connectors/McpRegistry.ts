/**
 * Search of the official MCP Registry (registry.modelcontextprotocol.io),
 * mapped into catalog entries the client can add with one click. Entries are
 * community-published; nothing here is verified by T3.
 *
 * Remote servers map to HTTP connectors (streamable HTTP only, since that is
 * what every provider speaks). npm, PyPI, and OCI packages map to stdio
 * connectors run through npx, uvx, or docker. Required environment
 * variables, headers, and positional arguments become fields.
 *
 * @module McpRegistry
 */
import type { McpCatalogEntry, McpCatalogField, McpRegistrySearchResult } from "@t3tools/contracts";

import type { FetchLike } from "./McpOAuth.ts";

export const MCP_REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";
const PAGE_SIZE = 30;

type UnknownRecord = Record<string, unknown>;
const asRecord = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
const asString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
const asArray = (value: unknown): ReadonlyArray<UnknownRecord> =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
      })
    : [];

const hostOf = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    return new URL(value).hostname || undefined;
  } catch {
    return undefined;
  }
};

/** Turns `{placeholder}` templates into the field `format` T3 understands. */
const templateFormat = (value: string | undefined) =>
  value && /\{[^}]+\}/.test(value) ? value.replace(/\{[^}]+\}/, "{value}") : undefined;

const displayName = (server: UnknownRecord, name: string) =>
  asString(server.title) ??
  (name.split("/").pop() ?? name)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

function remoteEntry(
  base: Omit<McpCatalogEntry, "connector" | "fields">,
  remote: UnknownRecord,
): McpCatalogEntry | undefined {
  const url = asString(remote.url);
  if (!url || url.includes("{")) return undefined;
  const fields: McpCatalogField[] = [];
  for (const header of asArray(remote.headers)) {
    const name = asString(header.name);
    if (!name || header.isRequired !== true) continue;
    const format = templateFormat(asString(header.value));
    fields.push({
      id: `header:${name}`,
      label: name,
      ...(asString(header.description) ? { description: asString(header.description)! } : {}),
      secret: header.isSecret === true || name.toLowerCase() === "authorization",
      required: true,
      target: { type: "header", name, ...(format ? { format } : {}) },
    });
  }
  const iconDomain = base.iconDomain ?? hostOf(url);
  return {
    ...base,
    ...(iconDomain ? { iconDomain } : {}),
    connector: {
      name: base.name,
      enabled: true,
      catalogId: base.id,
      // Sign-in is detected on install: a 401 with OAuth metadata switches it to OAuth.
      transport: { type: "http", url, headers: [], auth: { type: "none" } },
    },
    fields,
  };
}

const RUNTIMES = { npm: "npx", pypi: "uvx", oci: "docker" } as const;

function packageEntry(
  base: Omit<McpCatalogEntry, "connector" | "fields">,
  pkg: UnknownRecord,
): McpCatalogEntry | undefined {
  const registryType = asString(pkg.registryType);
  const identifier = asString(pkg.identifier);
  const transportType = asString(asRecord(pkg.transport)?.type) ?? "stdio";
  if (!identifier || transportType !== "stdio") return undefined;
  if (registryType !== "npm" && registryType !== "pypi" && registryType !== "oci") return undefined;
  const runtime = RUNTIMES[registryType];
  const version = asString(pkg.version);
  const fields: McpCatalogField[] = [];
  const envNames: string[] = [];
  for (const variable of asArray(pkg.environmentVariables)) {
    const name = asString(variable.name);
    if (!name || variable.isRequired !== true) continue;
    envNames.push(name);
    const defaultValue = asString(variable.default) ?? asString(variable.value);
    fields.push({
      id: `env:${name}`,
      label: name,
      ...(asString(variable.description) ? { description: asString(variable.description)! } : {}),
      secret: variable.isSecret === true,
      required: true,
      ...(defaultValue && !defaultValue.includes("{") ? { defaultValue } : {}),
      target: { type: "env", name },
    });
  }
  const trailing: string[] = [];
  for (const [index, argument] of asArray(pkg.packageArguments).entries()) {
    const value = asString(argument.value) ?? asString(argument.default);
    const name = argument.type === "named" ? asString(argument.name) : undefined;
    if (value && !value.includes("{")) {
      trailing.push(...(name ? [name, value] : [value]));
      continue;
    }
    if (argument.isRequired !== true) continue;
    fields.push({
      id: `arg:${index}`,
      label: name ?? asString(argument.valueHint) ?? `Argument ${index + 1}`,
      ...(asString(argument.description) ? { description: asString(argument.description)! } : {}),
      secret: false,
      required: true,
      target: { type: "arg", ...(name ? { name } : {}) },
    });
  }
  // Arguments the user fills land after these, so a required positional
  // argument with a blank before it would shift; such packages are rare.
  const args =
    runtime === "npx"
      ? ["-y", version ? `${identifier}@${version}` : identifier, ...trailing]
      : runtime === "uvx"
        ? [version ? `${identifier}@${version}` : identifier, ...trailing]
        : [
            "run",
            "-i",
            "--rm",
            ...envNames.flatMap((name) => ["-e", name]),
            identifier,
            ...trailing,
          ];
  return {
    ...base,
    runtime,
    connector: {
      name: base.name,
      enabled: true,
      catalogId: base.id,
      transport: { type: "stdio", command: runtime, args, env: [] },
    },
    fields,
  };
}

/** One registry `servers[]` item as a catalog entry, or undefined when T3 cannot run it. */
export function mapRegistryServer(item: unknown): McpCatalogEntry | undefined {
  const record = asRecord(item);
  const server = asRecord(record?.server) ?? record;
  if (!server) return undefined;
  const official = asRecord(asRecord(record?._meta)?.["io.modelcontextprotocol.registry/official"]);
  const status = asString(official?.status);
  if (status !== undefined && status !== "active") return undefined;
  const name = asString(server.name);
  if (!name) return undefined;
  const websiteUrl = asString(server.websiteUrl);
  const repositoryUrl = asString(asRecord(server.repository)?.url);
  const docsUrl = websiteUrl ?? repositoryUrl;
  const iconDomain = hostOf(websiteUrl);
  const base = {
    id: `registry:${name}`,
    name: displayName(server, name),
    description: asString(server.description) ?? "",
    source: "registry" as const,
    ...(iconDomain ? { iconDomain } : {}),
    ...(docsUrl ? { docsUrl } : {}),
  };
  for (const remote of asArray(server.remotes)) {
    if (asString(remote.type) !== "streamable-http") continue;
    const entry = remoteEntry(base, remote);
    if (entry) return entry;
  }
  const packages = asArray(server.packages);
  for (const registryType of ["npm", "pypi", "oci"]) {
    for (const pkg of packages) {
      if (asString(pkg.registryType) !== registryType) continue;
      const entry = packageEntry(base, pkg);
      if (entry) return entry;
    }
  }
  return undefined;
}

export function mapRegistryResponse(body: unknown): McpRegistrySearchResult {
  const record = asRecord(body);
  const seen = new Set<string>();
  const entries: McpCatalogEntry[] = [];
  for (const item of Array.isArray(record?.servers) ? record.servers : []) {
    const entry = mapRegistryServer(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return { entries, nextCursor: asString(asRecord(record?.metadata)?.nextCursor) ?? null };
}

export function registrySearchUrl(query: string, cursor?: string): string {
  const url = new URL("/v0.1/servers", MCP_REGISTRY_BASE_URL);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("version", "latest");
  if (query.trim()) url.searchParams.set("search", query.trim());
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
}

export async function searchMcpRegistry(
  fetchImpl: FetchLike,
  input: { readonly query: string; readonly cursor?: string; readonly timeoutMs: number },
): Promise<McpRegistrySearchResult> {
  const response = await fetchImpl(registrySearchUrl(input.query, input.cursor), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) throw new Error(`The MCP Registry answered HTTP ${response.status}.`);
  return mapRegistryResponse(await response.json());
}
