import {
  type DiscoveredMcpServer,
  type McpCatalogEntry,
  type McpConnectorCheck,
  type McpConnectorConfig,
  McpConnectorId,
  type McpConnectorDiscoverySource,
  type McpConnectorHttpAuth,
  type McpConnectorKeyValue,
  type ProviderDriverKind,
  T3_BUILT_IN_MCP_SERVER_NAME,
} from "@t3tools/contracts";

/**
 * What the server sends in place of a saved secret. Sending it back keeps the
 * stored value; sending "" clears it.
 */
export const REDACTED_SECRET = "••••••";

const MAX_CONNECTOR_ID_LENGTH = 64;

/**
 * A stable settings key derived from the connector's name: lowercase, every
 * character a provider would reject folded to "-", unique among `existingIds`,
 * and never T3's own built-in server name.
 */
export function connectorIdFromName(name: string, existingIds: Iterable<string>): McpConnectorId {
  const taken = new Set(existingIds);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, MAX_CONNECTOR_ID_LENGTH)
    .replace(/-+$/g, "");
  const base =
    slug.length === 0 ? "connector" : slug === T3_BUILT_IN_MCP_SERVER_NAME ? "t3-code-mcp" : slug;
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    const tail = `-${suffix}`;
    candidate = `${base.slice(0, MAX_CONNECTOR_ID_LENGTH - tail.length)}${tail}`;
  }
  return McpConnectorId.make(candidate);
}

export interface KeyValueRow {
  /** Client-only identity so React keys survive edits. */
  readonly key: string;
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}

export type ConnectorAuthType = "none" | "bearer" | "oauth";

export interface ConnectorFormState {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly command: string;
  /** One argument per line. */
  readonly argsText: string;
  readonly env: ReadonlyArray<KeyValueRow>;
  readonly url: string;
  readonly headers: ReadonlyArray<KeyValueRow>;
  readonly authType: ConnectorAuthType;
  readonly bearerToken: string;
  readonly oauthScopes: string;
  readonly oauthClientId: string;
  /** Null means every provider. */
  readonly providers: ReadonlyArray<ProviderDriverKind> | null;
}

let rowCounter = 0;
export function newKeyValueRow(secret = true): KeyValueRow {
  rowCounter += 1;
  return { key: `row-${rowCounter}`, name: "", value: "", secret };
}

function toRows(entries: ReadonlyArray<McpConnectorKeyValue>): KeyValueRow[] {
  return entries.map((entry) => ({ ...newKeyValueRow(entry.secret), ...entry }));
}

export function connectorFormFromConfig(config: McpConnectorConfig | null): ConnectorFormState {
  const transport = config?.transport;
  const auth = transport?.type === "http" ? transport.auth : null;
  return {
    name: config?.name ?? "",
    transport: transport?.type ?? "stdio",
    command: transport?.type === "stdio" ? transport.command : "",
    argsText: transport?.type === "stdio" ? transport.args.join("\n") : "",
    env: transport?.type === "stdio" ? toRows(transport.env) : [],
    url: transport?.type === "http" ? transport.url : "",
    headers: transport?.type === "http" ? toRows(transport.headers) : [],
    authType: auth?.type ?? "none",
    bearerToken: auth?.type === "bearer" ? auth.token : "",
    oauthScopes: auth?.type === "oauth" ? auth.scopes : "",
    oauthClientId: auth?.type === "oauth" ? auth.clientId : "",
    providers: config?.providers ?? null,
  };
}

/** One argument per line; blank lines are dropped so trailing newlines are harmless. */
export function parseArgsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Turning `secret` off on a saved secret clears its value: the marker is not
 * the real value and must never be saved as plain text.
 */
export function setRowSecret(row: KeyValueRow, secret: boolean): KeyValueRow {
  if (!secret && row.secret && row.value === REDACTED_SECRET) {
    return { ...row, secret, value: "" };
  }
  return { ...row, secret };
}

function toEntries(rows: ReadonlyArray<KeyValueRow>): McpConnectorKeyValue[] {
  return rows
    .filter((row) => row.name.trim().length > 0)
    .map((row) => ({ name: row.name.trim(), value: row.value, secret: row.secret }));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export type BuildConnectorResult =
  | { readonly ok: true; readonly config: McpConnectorConfig }
  | { readonly ok: false; readonly error: string };

/**
 * The config to save for a form. `previous` carries what the form does not
 * edit: whether the connector is enabled and when OAuth last connected.
 */
export function buildConnectorConfig(
  form: ConnectorFormState,
  previous: McpConnectorConfig | null,
): BuildConnectorResult {
  const name = form.name.trim();
  if (name.length === 0) return { ok: false, error: "Enter a name." };
  const providers = form.providers === null ? {} : { providers: [...form.providers] };
  // The last check described the old settings, so an edit drops it; the
  // catalog link stays so the connector keeps its tile.
  const base = {
    name,
    enabled: previous?.enabled ?? true,
    ...providers,
    ...(previous?.catalogId ? { catalogId: previous.catalogId } : {}),
  };
  if (form.transport === "stdio") {
    const command = form.command.trim();
    if (command.length === 0)
      return { ok: false, error: "Enter the command that starts the server." };
    return {
      ok: true,
      config: {
        ...base,
        transport: {
          type: "stdio",
          command,
          args: parseArgsText(form.argsText),
          env: toEntries(form.env),
        },
      },
    };
  }
  const url = form.url.trim();
  if (!isHttpUrl(url)) return { ok: false, error: "Enter an http:// or https:// URL." };
  const previousAuth = previous?.transport.type === "http" ? previous.transport.auth : null;
  const auth: McpConnectorHttpAuth =
    form.authType === "bearer"
      ? { type: "bearer", token: form.bearerToken.trim() }
      : form.authType === "oauth"
        ? {
            type: "oauth",
            scopes: form.oauthScopes.trim(),
            clientId: form.oauthClientId.trim(),
            // The server owns the connection; keep its timestamp so editing
            // the name does not look like a disconnect.
            connectedAt: previousAuth?.type === "oauth" ? previousAuth.connectedAt : null,
          }
        : { type: "none" };
  return {
    ok: true,
    config: { ...base, transport: { type: "http", url, headers: toEntries(form.headers), auth } },
  };
}

export type ConnectorStatus =
  | { readonly kind: "ready" }
  | { readonly kind: "missing-token" }
  | { readonly kind: "oauth-connected"; readonly connectedAt: string }
  | { readonly kind: "oauth-disconnected" };

export function connectorStatus(config: McpConnectorConfig): ConnectorStatus {
  if (config.transport.type !== "http") return { kind: "ready" };
  const auth = config.transport.auth;
  if (auth.type === "bearer") {
    return auth.token.length === 0 ? { kind: "missing-token" } : { kind: "ready" };
  }
  if (auth.type === "oauth") {
    return auth.connectedAt === null
      ? { kind: "oauth-disconnected" }
      : { kind: "oauth-connected", connectedAt: auth.connectedAt };
  }
  return { kind: "ready" };
}

/** One line identifying where the server runs: the command line or the URL. */
export function connectorTransportSummary(config: McpConnectorConfig): string {
  if (config.transport.type === "stdio") {
    return [config.transport.command, ...config.transport.args].join(" ");
  }
  return config.transport.url;
}

export function connectorProvidersSummary(
  providers: ReadonlyArray<ProviderDriverKind> | undefined,
  labelFor: (driver: ProviderDriverKind) => string,
): string | null {
  if (providers === undefined) return null;
  if (providers.length === 0) return "No providers";
  return `Only ${providers.map(labelFor).join(", ")}`;
}

export const DISCOVERY_SOURCE_LABELS: Readonly<Record<McpConnectorDiscoverySource, string>> = {
  "codex-config": "Codex",
  "claude-user": "Claude Code (user)",
  "claude-project": "Claude Code (project)",
  "mcp-json": "Project .mcp.json",
};

export interface DiscoveredServerGroup {
  readonly source: McpConnectorDiscoverySource;
  readonly label: string;
  readonly servers: ReadonlyArray<DiscoveredMcpServer>;
}

/** Discovered servers grouped by where they were found, in a fixed source order. */
export function groupDiscoveredServers(
  servers: ReadonlyArray<DiscoveredMcpServer>,
): DiscoveredServerGroup[] {
  return (Object.keys(DISCOVERY_SOURCE_LABELS) as McpConnectorDiscoverySource[]).flatMap(
    (source) => {
      const matching = servers.filter((server) => server.source === source);
      return matching.length === 0
        ? []
        : [{ source, label: DISCOVERY_SOURCE_LABELS[source], servers: matching }];
    },
  );
}

/** Discovered servers an Import all would add: importable and not already a connector. */
export function importableDiscoveredServers(
  servers: ReadonlyArray<DiscoveredMcpServer>,
): ReadonlyArray<DiscoveredMcpServer> {
  const seen = new Set<string>();
  return servers.filter((server) => {
    const key = server.name.toLowerCase();
    if (discoveredServerImportState(server) !== "importable" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Catalog ─────────────────────────────────────────────────────────────

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

export type CatalogTileState =
  | { readonly kind: "available" }
  | {
      readonly kind: "added";
      readonly id: McpConnectorId;
      readonly config: McpConnectorConfig;
      /** Absent until the first check finishes. */
      readonly check: McpConnectorCheck | undefined;
      readonly usesOAuth: boolean;
    };

/**
 * Whether a catalog entry is already a connector: added from that entry, or
 * (for imported servers) pointing at the same remote URL.
 */
export function catalogTileState(
  entry: McpCatalogEntry,
  connectors: Readonly<Record<string, McpConnectorConfig>>,
): CatalogTileState {
  const entryUrl =
    entry.connector.transport.type === "http" ? normalizeUrl(entry.connector.transport.url) : null;
  const match =
    Object.entries(connectors).find(([, config]) => config.catalogId === entry.id) ??
    (entryUrl === null
      ? undefined
      : Object.entries(connectors).find(
          ([, config]) =>
            config.transport.type === "http" && normalizeUrl(config.transport.url) === entryUrl,
        ));
  if (!match) return { kind: "available" };
  const [id, config] = match;
  return {
    kind: "added",
    id: id as McpConnectorId,
    config,
    check: config.lastCheck,
    usesOAuth: config.transport.type === "http" && config.transport.auth.type === "oauth",
  };
}

/** Built-in entries matching a search, by name or description. */
export function filterCatalog(
  entries: ReadonlyArray<McpCatalogEntry>,
  query: string,
): ReadonlyArray<McpCatalogEntry> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const text = `${entry.name} ${entry.description}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** Registry results minus the ones the built-in catalog already offers. */
export function registryEntriesToShow(
  registry: ReadonlyArray<McpCatalogEntry>,
  builtIns: ReadonlyArray<McpCatalogEntry>,
): ReadonlyArray<McpCatalogEntry> {
  const builtInUrls = new Set(
    builtIns.flatMap((entry) =>
      entry.connector.transport.type === "http"
        ? [normalizeUrl(entry.connector.transport.url)]
        : [],
    ),
  );
  return registry.filter(
    (entry) =>
      entry.connector.transport.type !== "http" ||
      !builtInUrls.has(normalizeUrl(entry.connector.transport.url)),
  );
}

/** Short status text for a connector's last check. */
export function connectorCheckLabel(check: McpConnectorCheck | undefined): string {
  if (!check) return "Not checked";
  if (check.status === "connected") {
    const count = check.toolCount ?? 0;
    return `Connected · ${count} ${count === 1 ? "tool" : "tools"}`;
  }
  return check.status === "needs-auth" ? "Needs sign-in" : "Not working";
}

export const RUNTIME_FIXES: Readonly<
  Record<
    "npx" | "uvx" | "docker",
    { readonly name: string; readonly url: string; readonly how: string }
  >
> = {
  npx: {
    name: "Node.js",
    url: "https://nodejs.org/en/download",
    how: "Install Node.js, which includes npx, on the machine running this environment.",
  },
  uvx: {
    name: "uv",
    url: "https://docs.astral.sh/uv/getting-started/installation/",
    how: "Install uv, which includes uvx, on the machine running this environment: curl -LsSf https://astral.sh/uv/install.sh | sh",
  },
  docker: {
    name: "Docker",
    url: "https://docs.docker.com/get-started/get-docker/",
    how: "Install Docker on the machine running this environment and make sure it is running.",
  },
};

/** Whether an Import action applies; already-imported or unrepresentable entries cannot. */
export function discoveredServerImportState(
  server: DiscoveredMcpServer,
): "importable" | "imported" | "unsupported" {
  if (server.importedAs !== undefined) return "imported";
  return server.connector === null ? "unsupported" : "importable";
}
