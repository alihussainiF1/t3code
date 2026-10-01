/**
 * Provider-neutral resolution of MCP connectors and the per-provider
 * translators that turn the resolved list into each harness's native MCP
 * configuration. Everything here is pure so adapters stay thin and the
 * mapping is testable without spawning providers.
 *
 * Secrets never go on argv. Codex and Claude receive them as environment
 * variables of the provider process and reference them by name (Codex
 * `bearer_token_env_var` / `env_http_headers` / `env_vars`, Claude `${VAR}`
 * expansion). ACP and OpenCode receive the config over their own protocol
 * channel (stdin JSON-RPC, loopback HTTP), so values are passed directly.
 *
 * @module McpConnectorTranslators
 */
import {
  type McpConnectorConfig,
  type McpConnectorId,
  type ProviderDriverKind,
  T3_BUILT_IN_MCP_SERVER_NAME,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { parse as parseToml } from "smol-toml";

export interface ResolvedMcpKeyValue {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}

export type ResolvedMcpConnector = {
  readonly id: McpConnectorId;
  readonly name: string;
} & (
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: ReadonlyArray<ResolvedMcpKeyValue>;
    }
  | {
      readonly type: "http";
      readonly url: string;
      readonly headers: ReadonlyArray<ResolvedMcpKeyValue>;
      /** Access token sent as `Authorization: Bearer`, from bearer or OAuth auth. */
      readonly bearerToken?: string;
    }
);

export interface McpConnectorSkip {
  readonly id: string;
  readonly reason: string;
}

export interface ResolveMcpConnectorsInput {
  /** Settings with secrets materialized (never the client-redacted form). */
  readonly connectors: Readonly<Record<string, McpConnectorConfig>>;
  readonly disabledForThread: ReadonlyArray<string>;
  readonly provider: ProviderDriverKind;
  /** Current OAuth access tokens by connector id. */
  readonly oauthAccessTokens: Readonly<Record<string, string | undefined>>;
}

/**
 * The connectors a provider session receives: enabled globally, not turned
 * off for the thread, allowed for this provider, and usable (OAuth
 * connectors need a token). Order follows settings for stable output.
 */
export function resolveMcpConnectors(input: ResolveMcpConnectorsInput): {
  readonly connectors: ReadonlyArray<ResolvedMcpConnector>;
  readonly skipped: ReadonlyArray<McpConnectorSkip>;
} {
  const disabled = new Set(input.disabledForThread);
  const connectors: ResolvedMcpConnector[] = [];
  const skipped: McpConnectorSkip[] = [];
  for (const [rawId, config] of Object.entries(input.connectors)) {
    const id = rawId as McpConnectorId;
    if (!config.enabled || disabled.has(id)) continue;
    if (config.providers !== undefined && !config.providers.includes(input.provider)) continue;
    const resolved = resolveMcpConnector(id, config, input.oauthAccessTokens[id]);
    if ("reason" in resolved) skipped.push(resolved);
    else connectors.push(resolved);
  }
  return { connectors, skipped };
}

/**
 * One connector with its credentials applied, or why it cannot be used
 * (a reserved id, a missing bearer token, an OAuth connector without a token).
 */
export function resolveMcpConnector(
  id: McpConnectorId,
  config: McpConnectorConfig,
  oauthAccessToken: string | undefined,
): ResolvedMcpConnector | McpConnectorSkip {
  if (id === T3_BUILT_IN_MCP_SERVER_NAME) {
    return { id, reason: `"${id}" is reserved for T3's built-in tools.` };
  }
  const transport = config.transport;
  if (transport.type === "stdio") {
    return {
      id,
      name: config.name,
      type: "stdio",
      command: transport.command,
      args: transport.args,
      env: transport.env.map(({ name, value, secret }) => ({ name, value, secret })),
    };
  }
  const headers = transport.headers.map(({ name, value, secret }) => ({ name, value, secret }));
  let bearerToken: string | undefined;
  if (transport.auth.type === "bearer") {
    if (transport.auth.token.length === 0) return { id, reason: "No bearer token is saved." };
    bearerToken = transport.auth.token;
  } else if (transport.auth.type === "oauth") {
    bearerToken = oauthAccessToken;
    if (!bearerToken) {
      return { id, reason: "Not connected. Connect it in Settings > Connectors." };
    }
  }
  return {
    id,
    name: config.name,
    type: "http",
    url: transport.url,
    // An explicit Authorization header would fight the bearer token.
    headers:
      bearerToken === undefined
        ? headers
        : headers.filter((header) => header.name.toLowerCase() !== "authorization"),
    ...(bearerToken !== undefined ? { bearerToken } : {}),
  };
}

function httpHeaderEntries(connector: Extract<ResolvedMcpConnector, { type: "http" }>) {
  return connector.bearerToken === undefined
    ? connector.headers
    : [
        ...connector.headers,
        { name: "Authorization", value: `Bearer ${connector.bearerToken}`, secret: true },
      ];
}

/** Environment variable carrying one connector secret into a provider process. */
const secretEnvName = (index: number, kind: string, slot: number | string) =>
  `T3_MCP_C${index}_${kind}${slot === "" ? "" : `_${slot}`}`;

// ── Codex ───────────────────────────────────────────────────────────────

const tomlString = (value: string) => JSON.stringify(value);
const tomlKey = (value: string) => (/^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value));
const tomlInlineTable = (entries: ReadonlyArray<readonly [string, string]>) =>
  `{ ${entries.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`;
const tomlArray = (values: ReadonlyArray<string>) => `[${values.map(tomlString).join(", ")}]`;

export interface CodexMcpConfig {
  /** `-c key=value` pairs for `codex app-server`, already split into argv. */
  readonly args: ReadonlyArray<string>;
  /** Variables to add to the Codex process environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Codex config overrides. Values are TOML (JSON strings are valid TOML basic
 * strings). Secret stdio env values reach the server through `env_vars`,
 * which forwards same-named variables from the Codex process, so two
 * connectors cannot give one secret name different values.
 */
export function toCodexMcpConfig(connectors: ReadonlyArray<ResolvedMcpConnector>): CodexMcpConfig {
  const args: string[] = [];
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const set = (id: string, key: string, value: string) =>
    args.push("-c", `mcp_servers.${id}.${key}=${value}`);
  connectors.forEach((connector, index) => {
    const id = connector.id;
    if (connector.type === "stdio") {
      set(id, "command", tomlString(connector.command));
      if (connector.args.length > 0) set(id, "args", tomlArray(connector.args));
      const plain = connector.env.filter((entry) => !entry.secret);
      if (plain.length > 0) {
        set(id, "env", tomlInlineTable(plain.map((entry) => [entry.name, entry.value] as const)));
      }
      const forwarded: string[] = [];
      for (const entry of connector.env.filter((item) => item.secret)) {
        const existing = env[entry.name];
        if (existing !== undefined && existing !== entry.value) {
          warnings.push(
            `Connector "${id}" was not given ${entry.name}: another connector sets a different secret value for it.`,
          );
          continue;
        }
        env[entry.name] = entry.value;
        forwarded.push(entry.name);
      }
      if (forwarded.length > 0) set(id, "env_vars", tomlArray(forwarded));
      return;
    }
    set(id, "url", tomlString(connector.url));
    if (connector.bearerToken !== undefined) {
      const name = secretEnvName(index, "BEARER", "");
      env[name] = connector.bearerToken;
      set(id, "bearer_token_env_var", tomlString(name));
    }
    const plain = connector.headers.filter((header) => !header.secret);
    if (plain.length > 0) {
      set(
        id,
        "http_headers",
        tomlInlineTable(plain.map((header) => [header.name, header.value] as const)),
      );
    }
    const secret = connector.headers.filter((header) => header.secret);
    if (secret.length > 0) {
      set(
        id,
        "env_http_headers",
        tomlInlineTable(
          secret.map((header, slot) => {
            const name = secretEnvName(index, "HEADER", slot);
            env[name] = header.value;
            return [header.name, name] as const;
          }),
        ),
      );
    }
  });
  return { args, env, warnings };
}

/** Server names under `[mcp_servers]` in a Codex `config.toml`; empty when it does not parse. */
export function codexConfiguredMcpServerNames(tomlText: string): ReadonlyArray<string> {
  try {
    const servers = (parseToml(tomlText) as Record<string, unknown>).mcp_servers;
    return servers !== null && typeof servers === "object" && !Array.isArray(servers)
      ? Object.keys(servers)
      : [];
  } catch {
    return [];
  }
}

/**
 * Keeps Codex from loading MCP servers from its own config, so T3's
 * connectors are the only ones: `-c mcp_servers.<name>.enabled=false` for
 * every configured server T3 does not itself set. Codex's `-c` parser splits
 * keys on dots, so names it cannot address are returned instead of guessed.
 */
export function toCodexMcpDisableArgs(
  configuredNames: ReadonlyArray<string>,
  t3ServerIds: ReadonlyArray<string>,
): { readonly args: ReadonlyArray<string>; readonly unaddressable: ReadonlyArray<string> } {
  const keep = new Set(t3ServerIds);
  const args: string[] = [];
  const unaddressable: string[] = [];
  for (const name of new Set(configuredNames)) {
    if (keep.has(name)) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      unaddressable.push(name);
      continue;
    }
    args.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  return { args, unaddressable };
}

// ── Claude Agent SDK ────────────────────────────────────────────────────

export type ClaudeMcpServerConfig =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: string[];
      readonly env: Record<string, string>;
    }
  | { readonly type: "http"; readonly url: string; readonly headers: Record<string, string> };

/**
 * The SDK hands `mcpServers` to the CLI as `--mcp-config` JSON on argv, so
 * secrets are referenced as `${VAR}` (expanded by Claude Code) and supplied
 * through the returned environment.
 */
export function toClaudeMcpServers(connectors: ReadonlyArray<ResolvedMcpConnector>): {
  readonly servers: Record<string, ClaudeMcpServerConfig>;
  readonly env: Record<string, string>;
} {
  const servers: Record<string, ClaudeMcpServerConfig> = {};
  const env: Record<string, string> = {};
  connectors.forEach((connector, index) => {
    const reference = (entry: ResolvedMcpKeyValue, kind: string, slot: number) => {
      if (!entry.secret) return entry.value;
      const name = secretEnvName(index, kind, slot);
      env[name] = entry.value;
      return `\${${name}}`;
    };
    if (connector.type === "stdio") {
      servers[connector.id] = {
        type: "stdio",
        command: connector.command,
        args: [...connector.args],
        env: Object.fromEntries(
          connector.env.map((entry, slot) => [entry.name, reference(entry, "ENV", slot)]),
        ),
      };
      return;
    }
    servers[connector.id] = {
      type: "http",
      url: connector.url,
      headers: Object.fromEntries(
        httpHeaderEntries(connector).map((header, slot) => [
          header.name,
          reference(header, "HEADER", slot),
        ]),
      ),
    };
  });
  return { servers, env };
}

// ── ACP (Cursor, Grok, Antigravity) ─────────────────────────────────────

export function toAcpMcpServers(
  connectors: ReadonlyArray<ResolvedMcpConnector>,
): ReadonlyArray<EffectAcpSchema.McpServer> {
  return connectors.map((connector) =>
    connector.type === "stdio"
      ? {
          name: connector.id,
          command: connector.command,
          args: [...connector.args],
          env: connector.env.map(({ name, value }) => ({ name, value })),
        }
      : {
          type: "http" as const,
          name: connector.id,
          url: connector.url,
          headers: httpHeaderEntries(connector).map(({ name, value }) => ({ name, value })),
        },
  );
}

/**
 * Drops servers whose transport the agent did not advertise in
 * `initialize.agentCapabilities.mcpCapabilities`. Stdio is mandatory in ACP;
 * HTTP and SSE are opt-in capabilities.
 */
export function filterAcpMcpServersByCapabilities(
  servers: ReadonlyArray<EffectAcpSchema.McpServer>,
  capabilities: { readonly http?: boolean; readonly sse?: boolean } | undefined,
): {
  readonly supported: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly unsupported: ReadonlyArray<EffectAcpSchema.McpServer>;
} {
  const supported: EffectAcpSchema.McpServer[] = [];
  const unsupported: EffectAcpSchema.McpServer[] = [];
  for (const server of servers) {
    const type = "type" in server ? server.type : "stdio";
    const ok =
      type === "http"
        ? capabilities?.http === true
        : type === "sse"
          ? capabilities?.sse === true
          : true;
    (ok ? supported : unsupported).push(server);
  }
  return { supported, unsupported };
}

// ── OpenCode ────────────────────────────────────────────────────────────

export type OpenCodeMcpConfig =
  | {
      readonly type: "local";
      readonly command: string[];
      readonly environment: Record<string, string>;
      readonly enabled: true;
    }
  | {
      readonly type: "remote";
      readonly url: string;
      readonly headers: Record<string, string>;
      readonly oauth: false;
      readonly enabled: true;
    };

/** Configs for `client.mcp.add`, which reaches OpenCode over its loopback HTTP API. */
export function toOpenCodeMcpConfigs(
  connectors: ReadonlyArray<ResolvedMcpConnector>,
): ReadonlyArray<{ readonly name: string; readonly config: OpenCodeMcpConfig }> {
  return connectors.map((connector) => ({
    name: connector.id,
    config:
      connector.type === "stdio"
        ? {
            type: "local",
            command: [connector.command, ...connector.args],
            environment: Object.fromEntries(
              connector.env.map((entry) => [entry.name, entry.value]),
            ),
            enabled: true,
          }
        : {
            type: "remote",
            url: connector.url,
            headers: Object.fromEntries(
              httpHeaderEntries(connector).map((header) => [header.name, header.value]),
            ),
            // T3 owns authorization; OpenCode must not start its own flow.
            oauth: false,
            enabled: true,
          },
  }));
}
