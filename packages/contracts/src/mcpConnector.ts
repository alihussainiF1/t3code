import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * MCP connectors: MCP servers the user configures once in T3 and every
 * provider session receives. T3 owns the definitions (settings.json) and the
 * secrets (server secret store); provider adapters only translate the resolved
 * list into their native MCP configuration.
 */

/**
 * Key of one `settings.mcpConnectors` entry. Restricted to characters every
 * provider accepts as an MCP server name (Codex TOML keys, Claude record keys,
 * ACP names, OpenCode names) so translation never has to rename.
 */
export const McpConnectorId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
).pipe(Schema.brand("McpConnectorId"));
export type McpConnectorId = typeof McpConnectorId.Type;

/** The id T3's built-in MCP server uses in every provider. Connectors may not take it. */
export const T3_BUILT_IN_MCP_SERVER_NAME = "t3-code";

/**
 * A name/value pair whose value may be secret. Secret values are stored in the
 * server secret store; settings and clients only see a redaction marker once
 * saved. A client that sends the marker back keeps the stored value.
 */
export const McpConnectorKeyValue = Schema.Struct({
  name: TrimmedNonEmptyString,
  value: Schema.String,
  secret: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type McpConnectorKeyValue = typeof McpConnectorKeyValue.Type;

export const McpConnectorStdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  env: Schema.Array(McpConnectorKeyValue).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type McpConnectorStdioTransport = typeof McpConnectorStdioTransport.Type;

export const McpConnectorHttpAuth = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("bearer"),
    /** Secret. Redacted to clients like other connector secrets. */
    token: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    /** Space-separated scopes to request; empty uses the server's defaults. */
    scopes: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    /**
     * A pre-registered client id. Empty means T3 registers itself through
     * dynamic client registration on first connect.
     */
    clientId: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    /**
     * When the last authorization completed. Null until the user connects or
     * after a disconnect. Tokens themselves never appear in settings.
     */
    connectedAt: Schema.NullOr(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
    ),
  }),
]);
export type McpConnectorHttpAuth = typeof McpConnectorHttpAuth.Type;

export const McpConnectorHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: TrimmedNonEmptyString,
  headers: Schema.Array(McpConnectorKeyValue).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  auth: McpConnectorHttpAuth.pipe(Schema.withDecodingDefault(Effect.succeed({ type: "none" }))),
});
export type McpConnectorHttpTransport = typeof McpConnectorHttpTransport.Type;

export const McpConnectorTransport = Schema.Union([
  McpConnectorStdioTransport,
  McpConnectorHttpTransport,
]);
export type McpConnectorTransport = typeof McpConnectorTransport.Type;

/**
 * The result of the server's last "does it work" check: an MCP initialize
 * and tools/list against the connector with its saved credentials.
 */
export const McpConnectorCheck = Schema.Struct({
  status: Schema.Literals(["connected", "needs-auth", "error"]),
  /** Tools the server listed; set when connected. */
  toolCount: Schema.optionalKey(Schema.Number),
  /** Why the check failed; set on error. */
  message: Schema.optionalKey(Schema.String),
  checkedAt: Schema.String,
});
export type McpConnectorCheck = typeof McpConnectorCheck.Type;

export const McpConnectorConfig = Schema.Struct({
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  transport: McpConnectorTransport,
  /**
   * Provider drivers that receive this connector. Absent means every
   * provider; an empty list means none.
   */
  providers: Schema.optionalKey(Schema.Array(ProviderDriverKind)),
  /** Catalog entry the connector was added from, so its tile shows the connection. */
  catalogId: Schema.optionalKey(Schema.String),
  /** Written by the server after each check; absent until the first one. */
  lastCheck: Schema.optionalKey(McpConnectorCheck),
});
export type McpConnectorConfig = typeof McpConnectorConfig.Type;

// ── Discovery of servers configured in the provider CLIs ────────────────

export const McpConnectorDiscoverySource = Schema.Literals([
  "codex-config",
  "claude-user",
  "claude-project",
  "mcp-json",
]);
export type McpConnectorDiscoverySource = typeof McpConnectorDiscoverySource.Type;

export const DiscoveredMcpServer = Schema.Struct({
  /** Server name as the CLI config spells it. */
  name: Schema.String,
  source: McpConnectorDiscoverySource,
  /** File the entry was read from, for display. */
  path: Schema.String,
  /**
   * The connector an import would create, with every env and header value
   * redacted, or null when the entry cannot be represented. Imports run on
   * the server, which re-reads the real values and stores them as secrets.
   */
  connector: Schema.NullOr(McpConnectorConfig),
  /** Id of an existing connector with the same name, when already imported. */
  importedAs: Schema.optionalKey(McpConnectorId),
  /** Why the entry cannot be imported, or what an import leaves out. */
  note: Schema.optionalKey(Schema.String),
});
export type DiscoveredMcpServer = typeof DiscoveredMcpServer.Type;

export const McpConnectorDiscoverInput = Schema.Struct({
  /** Project directory to look for `.mcp.json` and Claude project entries in. */
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});
export type McpConnectorDiscoverInput = typeof McpConnectorDiscoverInput.Type;

export const McpConnectorDiscoverResult = Schema.Struct({
  servers: Schema.Array(DiscoveredMcpServer),
});
export type McpConnectorDiscoverResult = typeof McpConnectorDiscoverResult.Type;

export const McpConnectorImportInput = Schema.Struct({
  source: McpConnectorDiscoverySource,
  name: Schema.String,
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});
export type McpConnectorImportInput = typeof McpConnectorImportInput.Type;

export const McpConnectorImportResult = Schema.Struct({
  connectorId: McpConnectorId,
});
export type McpConnectorImportResult = typeof McpConnectorImportResult.Type;

// ── OAuth for remote connectors ─────────────────────────────────────────

export const McpConnectorOAuthStartInput = Schema.Struct({
  connectorId: McpConnectorId,
  /**
   * The server's HTTP origin as the client reaches it (for example the SSH
   * tunnel's localhost port). The authorization server redirects the
   * browser back to `<redirectBaseUrl>/oauth/mcp/callback`.
   */
  redirectBaseUrl: TrimmedNonEmptyString,
});
export type McpConnectorOAuthStartInput = typeof McpConnectorOAuthStartInput.Type;

export const McpConnectorOAuthStartResult = Schema.Struct({
  authorizationUrl: Schema.String,
});
export type McpConnectorOAuthStartResult = typeof McpConnectorOAuthStartResult.Type;

export const McpConnectorOAuthDisconnectInput = Schema.Struct({
  connectorId: McpConnectorId,
});
export type McpConnectorOAuthDisconnectInput = typeof McpConnectorOAuthDisconnectInput.Type;

export const McpConnectorImportAllInput = Schema.Struct({
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});
export type McpConnectorImportAllInput = typeof McpConnectorImportAllInput.Type;

export const McpConnectorImportAllResult = Schema.Struct({
  imported: Schema.Array(McpConnectorId),
  skipped: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
});
export type McpConnectorImportAllResult = typeof McpConnectorImportAllResult.Type;

// ── Adding and checking connectors ──────────────────────────────────────

export const McpConnectorInstallInput = Schema.Struct({
  config: McpConnectorConfig,
});
export type McpConnectorInstallInput = typeof McpConnectorInstallInput.Type;

export const McpConnectorInstallResult = Schema.Struct({
  connectorId: McpConnectorId,
  /** The first check. OAuth connectors report needs-auth until signed in. */
  check: McpConnectorCheck,
});
export type McpConnectorInstallResult = typeof McpConnectorInstallResult.Type;

export const McpConnectorTestInput = Schema.Struct({
  connectorId: McpConnectorId,
});
export type McpConnectorTestInput = typeof McpConnectorTestInput.Type;

/** Launchers that local catalog entries rely on, as found on the environment's PATH. */
export const McpConnectorRuntimes = Schema.Struct({
  npx: Schema.Boolean,
  uvx: Schema.Boolean,
  docker: Schema.Boolean,
});
export type McpConnectorRuntimes = typeof McpConnectorRuntimes.Type;

export const McpConnectorIconsInput = Schema.Struct({
  domains: Schema.Array(Schema.String).check(Schema.isMaxLength(64)),
});
export type McpConnectorIconsInput = typeof McpConnectorIconsInput.Type;

export const McpConnectorIconsResult = Schema.Struct({
  /** `data:` URLs by domain; null when the domain has no usable icon. */
  icons: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
});
export type McpConnectorIconsResult = typeof McpConnectorIconsResult.Type;

export class McpConnectorError extends Schema.TaggedError<McpConnectorError>()(
  "McpConnectorError",
  {
    connectorId: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
