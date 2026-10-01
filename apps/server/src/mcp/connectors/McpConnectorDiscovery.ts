/**
 * Read-only discovery of MCP servers already configured in the provider
 * CLIs (Codex `config.toml`, Claude `~/.claude.json` and `.mcp.json`), so the
 * user can import them into T3 with one click. Parsing is pure; the service
 * reads the files.
 *
 * Imported env and header values are stored as secrets: CLI configs do not
 * say which values are sensitive, and treating all of them as secret is the
 * direction that cannot leak.
 *
 * @module McpConnectorDiscovery
 */
import {
  type McpConnectorConfig,
  type McpConnectorDiscoverySource,
  McpConnectorId,
  type McpConnectorKeyValue,
  T3_BUILT_IN_MCP_SERVER_NAME,
} from "@t3tools/contracts";
import { parse as parseToml } from "smol-toml";

export interface DiscoveredMcpServerEntry {
  readonly name: string;
  readonly source: McpConnectorDiscoverySource;
  readonly path: string;
  readonly connector: McpConnectorConfig | null;
  readonly note?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
const asStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Expands `${VAR}` and `${VAR:-default}` the way Claude Code does, from the server's environment. */
export function expandEnvironmentReferences(
  value: string,
  environment: Environment,
): { readonly value: string; readonly missing: ReadonlyArray<string> } {
  const missing: string[] = [];
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const found = environment[name];
      if (found !== undefined && found !== "") return found;
      if (fallback !== undefined) return fallback;
      missing.push(name);
      return "";
    },
  );
  return { value: expanded, missing };
}

function keyValues(
  record: Record<string, unknown> | undefined,
  environment: Environment,
  missing: string[],
): McpConnectorKeyValue[] {
  return Object.entries(record ?? {}).flatMap(([name, raw]) => {
    const text =
      asString(raw) ??
      (typeof raw === "number" || typeof raw === "boolean" ? String(raw) : undefined);
    if (text === undefined || name.trim().length === 0) return [];
    const expanded = expandEnvironmentReferences(text, environment);
    missing.push(...expanded.missing);
    return [{ name: name.trim(), value: expanded.value, secret: expanded.value.length > 0 }];
  });
}

const missingNote = (missing: ReadonlyArray<string>) =>
  missing.length > 0
    ? `References ${[...new Set(missing)].join(", ")}, which the T3 server's environment does not set; fill those values in after importing.`
    : undefined;

/** Claude's `mcpServers` record, as found in `~/.claude.json` and `.mcp.json`. */
export function parseClaudeMcpServers(
  value: unknown,
  input: {
    readonly source: McpConnectorDiscoverySource;
    readonly path: string;
    readonly environment: Environment;
  },
): ReadonlyArray<DiscoveredMcpServerEntry> {
  const servers = asRecord(value);
  if (!servers) return [];
  return Object.entries(servers).map(([name, raw]) => {
    const base = { name, source: input.source, path: input.path };
    const entry = asRecord(raw);
    if (!entry) return { ...base, connector: null, note: "Unreadable entry." };
    const type = asString(entry.type) ?? (entry.url !== undefined ? "http" : "stdio");
    const missing: string[] = [];
    if (type === "stdio") {
      const command = asString(entry.command)?.trim();
      if (!command) return { ...base, connector: null, note: "No command." };
      const args = asStringArray(entry.args).map((arg) => {
        const expanded = expandEnvironmentReferences(arg, input.environment);
        missing.push(...expanded.missing);
        return expanded.value;
      });
      const note = missingNote(missing);
      return {
        ...base,
        connector: {
          name,
          enabled: true,
          transport: {
            type: "stdio",
            command,
            args,
            env: keyValues(asRecord(entry.env), input.environment, missing),
          },
        },
        ...(note ? { note } : {}),
      };
    }
    if (type === "http") {
      const url = asString(entry.url)?.trim();
      if (!url) return { ...base, connector: null, note: "No URL." };
      const headers = keyValues(asRecord(entry.headers), input.environment, missing);
      const note = missingNote(missing);
      return {
        ...base,
        connector: {
          name,
          enabled: true,
          transport: {
            type: "http",
            url: expandEnvironmentReferences(url, input.environment).value,
            headers,
            // Claude signs in to header-less remote servers itself; T3 does the same.
            auth: headers.some((header) => header.name.toLowerCase() === "authorization")
              ? { type: "none" }
              : { type: "oauth", scopes: "", clientId: "", connectedAt: null },
          },
        },
        ...(note ? { note } : {}),
      };
    }
    return {
      ...base,
      connector: null,
      note: `The ${type} transport is not supported. Use the server's streamable HTTP endpoint.`,
    };
  });
}

/** `[mcp_servers.<name>]` tables from a Codex `config.toml`. */
export function parseCodexMcpServers(
  text: string,
  input: { readonly path: string; readonly environment: Environment },
): ReadonlyArray<DiscoveredMcpServerEntry> {
  let document: Record<string, unknown>;
  try {
    document = parseToml(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const servers = asRecord(document.mcp_servers);
  if (!servers) return [];
  return Object.entries(servers).map(([name, raw]) => {
    const base = { name, source: "codex-config" as const, path: input.path };
    const entry = asRecord(raw);
    if (!entry) return { ...base, connector: null, note: "Unreadable entry." };
    const notes: string[] = [];
    const enabled = entry.enabled !== false;
    if (typeof entry.cwd === "string") notes.push("Its working directory is not imported.");
    const command = asString(entry.command)?.trim();
    if (command) {
      const env = keyValues(asRecord(entry.env), input.environment, []);
      for (const forwarded of asStringArray(entry.env_vars)) {
        const value = input.environment[forwarded];
        if (value === undefined) {
          notes.push(`${forwarded} is not set in the T3 server's environment.`);
          continue;
        }
        env.push({ name: forwarded, value, secret: true });
      }
      return {
        ...base,
        connector: {
          name,
          enabled,
          transport: { type: "stdio", command, args: asStringArray(entry.args), env },
        },
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      };
    }
    const url = asString(entry.url)?.trim();
    if (!url) return { ...base, connector: null, note: "No command or URL." };
    const headers = keyValues(asRecord(entry.http_headers), input.environment, []);
    for (const [header, variable] of Object.entries(asRecord(entry.env_http_headers) ?? {})) {
      const value = typeof variable === "string" ? input.environment[variable] : undefined;
      if (value === undefined) {
        notes.push(
          `${String(variable)} (for ${header}) is not set in the T3 server's environment.`,
        );
        continue;
      }
      headers.push({ name: header, value, secret: true });
    }
    const bearerVariable = asString(entry.bearer_token_env_var);
    const bearer = bearerVariable ? input.environment[bearerVariable] : undefined;
    if (bearerVariable && bearer === undefined) {
      notes.push(
        `${bearerVariable} is not set in the T3 server's environment; add the token after importing.`,
      );
    }
    return {
      ...base,
      connector: {
        name,
        enabled,
        transport: {
          type: "http",
          url,
          headers,
          auth: bearer
            ? { type: "bearer", token: bearer }
            : bearerVariable
              ? { type: "bearer", token: "" }
              : {
                  type: "oauth",
                  scopes: asStringArray(entry.scopes).join(" "),
                  clientId: "",
                  connectedAt: null,
                },
        },
      },
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  });
}

/**
 * A connector id derived from a display name: lowercase, safe for every
 * provider's MCP server naming, and unique among `taken`.
 */
export function connectorIdFromName(name: string, taken: ReadonlySet<string>): McpConnectorId {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 56) || "connector";
  const base = slug === T3_BUILT_IN_MCP_SERVER_NAME ? `${slug}-mcp` : slug;
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
  return McpConnectorId.make(candidate);
}

/** The discovery view of a connector: every env/header value and token blanked. */
export function redactDiscoveredConnector(connector: McpConnectorConfig): McpConnectorConfig {
  const blank = (entries: ReadonlyArray<McpConnectorKeyValue>) =>
    entries.map((entry) => ({ ...entry, value: entry.value.length > 0 ? "••••••" : "" }));
  const transport = connector.transport;
  if (transport.type === "stdio") {
    return { ...connector, transport: { ...transport, env: blank(transport.env) } };
  }
  return {
    ...connector,
    transport: {
      ...transport,
      headers: blank(transport.headers),
      auth:
        transport.auth.type === "bearer"
          ? { type: "bearer", token: transport.auth.token.length > 0 ? "••••••" : "" }
          : transport.auth,
    },
  };
}
