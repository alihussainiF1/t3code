/**
 * McpConnectorService - resolves the user's MCP connectors for provider
 * sessions, discovers servers configured in the provider CLIs, and runs the
 * OAuth flow for remote connectors.
 *
 * T3 is the source of truth: connector definitions live in settings, their
 * secrets and OAuth tokens in the server secret store, and every provider
 * receives the same resolved list through its adapter's translator.
 *
 * @module McpConnectorService
 */
import * as NodeOS from "node:os";

import {
  type McpConnectorCheck,
  type McpConnectorConfig,
  type McpConnectorIconsInput,
  type McpConnectorIconsResult,
  type McpConnectorImportAllInput,
  type McpConnectorImportAllResult,
  type McpConnectorInstallInput,
  type McpConnectorInstallResult,
  type McpConnectorRuntimes,
  type McpConnectorTestInput,
  type McpRegistrySearchInput,
  type McpRegistrySearchResult,
  type McpConnectorDiscoverInput,
  type McpConnectorDiscoverResult,
  McpConnectorError,
  type McpConnectorId,
  type McpConnectorImportInput,
  type McpConnectorImportResult,
  type McpConnectorOAuthDisconnectInput,
  type McpConnectorOAuthStartInput,
  type McpConnectorOAuthStartResult,
  type ProviderDriverKind,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  mapMcpConnectorSecrets,
  mcpConnectorSecretName,
  ServerSettingsService,
} from "../../serverSettings.ts";
import {
  connectorIdFromName,
  type DiscoveredMcpServerEntry,
  parseClaudeMcpServers,
  parseCodexMcpServers,
  redactDiscoveredConnector,
} from "./McpConnectorDiscovery.ts";
import {
  buildMcpAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  discoverMcpOAuth,
  exchangeMcpAuthorizationCode,
  type FetchLike,
  type McpOAuthClient,
  refreshMcpAccessToken,
  registerMcpOAuthClient,
  shouldRefreshMcpToken,
} from "./McpOAuth.ts";
import {
  resolveMcpConnector,
  resolveMcpConnectors,
  type ResolvedMcpConnector,
} from "./McpConnectorTranslators.ts";
import {
  createHttpProbeTransport,
  createStdioProbeTransport,
  type McpProbeOutcome,
  probeMcpServer,
} from "./McpConnectorProbe.ts";
import { searchMcpRegistry } from "./McpRegistry.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";

/** Path of the OAuth redirect target on the T3 server. */
export const MCP_CONNECTOR_OAUTH_CALLBACK_PATH = "/oauth/mcp-connectors/callback";

const PENDING_FLOW_TTL_MS = 10 * 60 * 1000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Everything T3 keeps for one connected OAuth connector, stored as one secret. */
const StoredOAuthState = Schema.Struct({
  issuer: Schema.String,
  tokenEndpoint: Schema.String,
  resource: Schema.String,
  redirectUri: Schema.String,
  clientId: Schema.String,
  clientSecret: Schema.optionalKey(Schema.String),
  /** Whether T3 registered the client itself (and may register again). */
  registered: Schema.Boolean,
  accessToken: Schema.String,
  refreshToken: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
});
type StoredOAuthState = typeof StoredOAuthState.Type;
const decodeStoredOAuthState = Schema.decodeUnknownOption(Schema.fromJsonString(StoredOAuthState));
const encodeStoredOAuthState = Schema.encodeSync(Schema.fromJsonString(StoredOAuthState));
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

interface PendingOAuthFlow {
  readonly connectorId: McpConnectorId;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly resource: string;
  readonly client: McpOAuthClient;
  readonly registered: boolean;
  readonly createdAt: number;
}

export interface ResolveSessionConnectorsInput {
  readonly provider: ProviderDriverKind;
  readonly disabledForThread: ReadonlyArray<string>;
}

export class McpConnectorService extends Context.Service<
  McpConnectorService,
  {
    /**
     * The connectors a new provider session receives, with secrets and fresh
     * OAuth access tokens filled in. Never fails: a connector that cannot be
     * used is left out and logged, so one broken connector cannot block a
     * session.
     */
    readonly resolveForSession: (
      input: ResolveSessionConnectorsInput,
    ) => Effect.Effect<ReadonlyArray<ResolvedMcpConnector>>;
    readonly discover: (
      input: McpConnectorDiscoverInput,
    ) => Effect.Effect<McpConnectorDiscoverResult>;
    readonly importServer: (
      input: McpConnectorImportInput,
    ) => Effect.Effect<McpConnectorImportResult, McpConnectorError>;
    readonly startOAuth: (
      input: McpConnectorOAuthStartInput,
    ) => Effect.Effect<McpConnectorOAuthStartResult, McpConnectorError>;
    /**
     * Handles the authorization server's redirect: stores the grant, then
     * checks the connector with it. Returns the display name and the check.
     */
    readonly completeOAuth: (input: {
      readonly state: string;
      readonly code?: string;
      readonly error?: string;
      readonly errorDescription?: string;
    }) => Effect.Effect<
      { readonly name: string; readonly check: McpConnectorCheck | undefined },
      McpConnectorError
    >;
    readonly disconnectOAuth: (
      input: McpConnectorOAuthDisconnectInput,
    ) => Effect.Effect<void, McpConnectorError>;
    /** Imports every discovered server not already a connector, secrets included. */
    readonly importAll: (
      input: McpConnectorImportAllInput,
    ) => Effect.Effect<McpConnectorImportAllResult, McpConnectorError>;
    /** Adds a connector (usually from the catalog) and checks it. */
    readonly install: (
      input: McpConnectorInstallInput,
    ) => Effect.Effect<McpConnectorInstallResult, McpConnectorError>;
    /** Runs the MCP handshake against a connector and records the result on it. */
    readonly test: (
      input: McpConnectorTestInput,
    ) => Effect.Effect<McpConnectorCheck, McpConnectorError>;
    readonly runtimes: Effect.Effect<McpConnectorRuntimes>;
    readonly icons: (input: McpConnectorIconsInput) => Effect.Effect<McpConnectorIconsResult>;
    readonly searchRegistry: (
      input: McpRegistrySearchInput,
    ) => Effect.Effect<McpRegistrySearchResult, McpConnectorError>;
  }
>()("t3/mcp/connectors/McpConnectorService") {}

export interface McpConnectorServiceOptions {
  readonly fetch?: FetchLike;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  /** Replaces the network/process handshake, for tests. */
  readonly probe?: (connector: ResolvedMcpConnector) => Promise<McpProbeOutcome>;
}

const HTTP_PROBE_TIMEOUT_MS = 20_000;
// First runs of npx/uvx download the package, which can take a while.
const STDIO_PROBE_TIMEOUT_MS = 90_000;
const REGISTRY_TIMEOUT_MS = 8_000;
const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;
const ICON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ICON_MAX_BYTES = 32 * 1024;
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

const fail = (operation: string, detail: string, connectorId?: string) =>
  new McpConnectorError({ operation, detail, ...(connectorId ? { connectorId } : {}) });

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const make = (options: McpConnectorServiceOptions = {}) =>
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fetchImpl: FetchLike =
      options.fetch ??
      // The OAuth helpers are plain async functions over an injected fetch so
      // they can be exercised with canned responses.
      // @effect-diagnostics-next-line globalFetch:off
      ((input, init) => fetch(input, init));
    const environment = options.environment ?? process.env;
    const homeDirectory = options.homeDirectory ?? NodeOS.homedir();
    const pendingFlows = new Map<string, PendingOAuthFlow>();
    // Refresh tokens may rotate; two sessions refreshing at once would burn one.
    const refreshLock = yield* Semaphore.make(1);
    // Server-side rewrites of one entry (connection time, check results) read
    // the current entry and write it back; serializing them keeps a slow check
    // from writing back a connection state it read before a disconnect.
    const entryLock = yield* Semaphore.make(1);
    // Checks started after a sign-in or an import outlive the request.
    const serviceScope = yield* Effect.scope;

    const tryPromise = <A>(operation: string, connectorId: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => fail(operation, describe(cause), connectorId),
      });

    const getSettings = settingsService.getSettings.pipe(
      Effect.mapError((cause) => fail("read-settings", cause.message)),
    );

    const readOAuthState = (connectorId: string) =>
      secretStore.get(mcpConnectorSecretName(connectorId, "oauth")).pipe(
        Effect.map((secret) =>
          Option.isSome(secret)
            ? Option.getOrUndefined(decodeStoredOAuthState(textDecoder.decode(secret.value)))
            : undefined,
        ),
        Effect.mapError((cause) => fail("read-token", cause.message, connectorId)),
      );

    const writeOAuthState = (connectorId: string, state: StoredOAuthState) =>
      secretStore
        .set(
          mcpConnectorSecretName(connectorId, "oauth"),
          textEncoder.encode(encodeStoredOAuthState(state)),
        )
        .pipe(Effect.mapError((cause) => fail("write-token", cause.message, connectorId)));

    /** Rewrites one connector entry, sending secrets back as the redaction marker so they are kept. */
    const updateConnector = (
      connectorId: string,
      update: (connector: McpConnectorConfig) => McpConnectorConfig,
    ) =>
      Effect.gen(function* () {
        const settings = yield* getSettings;
        const connector = (settings.mcpConnectors as Record<string, McpConnectorConfig>)[
          connectorId
        ];
        if (!connector) return;
        const marked = mapMcpConnectorSecrets(connectorId, update(connector), ({ value }) =>
          value.length > 0 ? "••••••" : "",
        );
        yield* settingsService
          .updateSettings({ mcpConnectors: { [connectorId]: marked } })
          .pipe(Effect.mapError((cause) => fail("write-settings", cause.message, connectorId)));
      }).pipe(entryLock.withPermits(1));

    const setConnectedAt = (connectorId: string, connectedAt: string | null) =>
      updateConnector(connectorId, (connector) =>
        connector.transport.type === "http" && connector.transport.auth.type === "oauth"
          ? {
              ...connector,
              transport: {
                ...connector.transport,
                auth: { ...connector.transport.auth, connectedAt },
              },
            }
          : connector,
      );

    /** A usable access token, refreshed when it is about to expire. */
    const accessTokenFor = (connectorId: string) =>
      refreshLock.withPermits(1)(
        Effect.gen(function* () {
          const stored = yield* readOAuthState(connectorId);
          if (!stored) return undefined;
          const now = yield* Clock.currentTimeMillis;
          if (!shouldRefreshMcpToken(stored, now)) return stored.accessToken;
          if (!stored.refreshToken) {
            return stored.expiresAt !== undefined && stored.expiresAt > now
              ? stored.accessToken
              : undefined;
          }
          const refreshed = yield* tryPromise("refresh-token", connectorId, () =>
            refreshMcpAccessToken(fetchImpl, {
              tokenEndpoint: stored.tokenEndpoint,
              client: {
                clientId: stored.clientId,
                ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
              },
              refreshToken: stored.refreshToken!,
              resource: stored.resource,
              now,
            }),
          ).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("MCP connector token refresh failed", {
                connectorId,
                detail: error.detail,
              }),
            ),
            Effect.option,
          );
          if (Option.isNone(refreshed)) {
            if (stored.expiresAt !== undefined && stored.expiresAt > now) return stored.accessToken;
            // The grant is gone; show the connector as needing a reconnect.
            yield* setConnectedAt(connectorId, null).pipe(Effect.ignore);
            return undefined;
          }
          const { refreshToken: _refresh, expiresAt: _expires, scope: _scope, ...rest } = stored;
          yield* writeOAuthState(connectorId, {
            ...rest,
            accessToken: refreshed.value.accessToken,
            ...(refreshed.value.refreshToken ? { refreshToken: refreshed.value.refreshToken } : {}),
            ...(refreshed.value.expiresAt !== undefined
              ? { expiresAt: refreshed.value.expiresAt }
              : {}),
            ...(refreshed.value.scope ? { scope: refreshed.value.scope } : {}),
          });
          return refreshed.value.accessToken;
        }),
      );

    const resolveForSession = (input: ResolveSessionConnectorsInput) =>
      Effect.gen(function* () {
        const settings: ServerSettings = yield* getSettings;
        const connectors: Readonly<Record<string, McpConnectorConfig>> = settings.mcpConnectors;
        const disabled = new Set(input.disabledForThread);
        const oauthAccessTokens: Record<string, string | undefined> = {};
        for (const [id, connector] of Object.entries(connectors)) {
          if (!connector.enabled || disabled.has(id)) continue;
          if (connector.providers !== undefined && !connector.providers.includes(input.provider)) {
            continue;
          }
          if (connector.transport.type !== "http" || connector.transport.auth.type !== "oauth") {
            continue;
          }
          oauthAccessTokens[id] = yield* accessTokenFor(id).pipe(
            Effect.catch((error) =>
              Effect.logWarning("MCP connector token unavailable", {
                connectorId: id,
                detail: error.detail,
              }).pipe(Effect.as(undefined)),
            ),
          );
        }
        const resolved = resolveMcpConnectors({
          connectors,
          disabledForThread: input.disabledForThread,
          provider: input.provider,
          oauthAccessTokens,
        });
        for (const skip of resolved.skipped) {
          yield* Effect.logWarning("MCP connector left out of provider session", {
            connectorId: skip.id,
            provider: input.provider,
            reason: skip.reason,
          });
        }
        return resolved.connectors;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "Could not resolve MCP connectors; starting the session without them.",
            {
              detail: error.detail,
            },
          ).pipe(Effect.as([] as ReadonlyArray<ResolvedMcpConnector>)),
        ),
      );

    const readOptionalFile = (filePath: string) =>
      fileSystem.readFileString(filePath).pipe(Effect.option);

    const discoverEntries = (input: McpConnectorDiscoverInput) =>
      Effect.gen(function* () {
        const entries: DiscoveredMcpServerEntry[] = [];
        const codexHome = environment.CODEX_HOME?.trim() || path.join(homeDirectory, ".codex");
        const codexPath = path.join(codexHome, "config.toml");
        const codexConfig = yield* readOptionalFile(codexPath);
        if (Option.isSome(codexConfig)) {
          entries.push(
            ...parseCodexMcpServers(codexConfig.value, { path: codexPath, environment }),
          );
        }
        const claudeConfigDir = environment.CLAUDE_CONFIG_DIR?.trim();
        const claudePath = claudeConfigDir
          ? path.join(claudeConfigDir, ".claude.json")
          : path.join(homeDirectory, ".claude.json");
        const claudeConfig = yield* readOptionalFile(claudePath);
        if (Option.isSome(claudeConfig)) {
          const parsed = decodeJsonOption(claudeConfig.value);
          const record =
            Option.isSome(parsed) && parsed.value !== null && typeof parsed.value === "object"
              ? (parsed.value as Record<string, unknown>)
              : undefined;
          if (record) {
            entries.push(
              ...parseClaudeMcpServers(record.mcpServers, {
                source: "claude-user",
                path: claudePath,
                environment,
              }),
            );
            const projects = record.projects as
              | Record<string, { mcpServers?: unknown }>
              | undefined;
            if (input.cwd && projects && typeof projects === "object") {
              entries.push(
                ...parseClaudeMcpServers(projects[input.cwd]?.mcpServers, {
                  source: "claude-project",
                  path: claudePath,
                  environment,
                }),
              );
            }
          }
        }
        if (input.cwd) {
          const mcpJsonPath = path.join(input.cwd, ".mcp.json");
          const mcpJson = yield* readOptionalFile(mcpJsonPath);
          if (Option.isSome(mcpJson)) {
            const parsed = decodeJsonOption(mcpJson.value);
            if (
              Option.isSome(parsed) &&
              parsed.value !== null &&
              typeof parsed.value === "object"
            ) {
              entries.push(
                ...parseClaudeMcpServers((parsed.value as Record<string, unknown>).mcpServers, {
                  source: "mcp-json",
                  path: mcpJsonPath,
                  environment,
                }),
              );
            }
          }
        }
        return entries;
      });

    const discover = (input: McpConnectorDiscoverInput) =>
      Effect.gen(function* () {
        const entries = yield* discoverEntries(input);
        const settings = yield* getSettings.pipe(Effect.option);
        const existing = Option.isSome(settings)
          ? Object.entries(settings.value.mcpConnectors as Record<string, McpConnectorConfig>)
          : [];
        return {
          servers: entries.map((entry) => {
            const match = existing.find(
              ([, connector]) => connector.name.toLowerCase() === entry.name.toLowerCase(),
            );
            return {
              name: entry.name,
              source: entry.source,
              path: entry.path,
              connector: entry.connector ? redactDiscoveredConnector(entry.connector) : null,
              ...(match ? { importedAs: match[0] as McpConnectorId } : {}),
              ...(entry.note ? { note: entry.note } : {}),
            };
          }),
        } satisfies McpConnectorDiscoverResult;
      });

    const importServer = (input: McpConnectorImportInput) =>
      Effect.gen(function* () {
        const entries = yield* discoverEntries(input);
        const entry = entries.find(
          (candidate) => candidate.source === input.source && candidate.name === input.name,
        );
        if (!entry?.connector) {
          return yield* fail(
            "import",
            entry?.note ?? `"${input.name}" is no longer in that configuration.`,
          );
        }
        const settings = yield* getSettings;
        const id = connectorIdFromName(entry.name, new Set(Object.keys(settings.mcpConnectors)));
        yield* settingsService
          .updateSettings({ mcpConnectors: { [id]: entry.connector } })
          .pipe(Effect.mapError((cause) => fail("import", cause.message, id)));
        return { connectorId: id };
      });

    const startOAuth = (input: McpConnectorOAuthStartInput) =>
      Effect.gen(function* () {
        const settings = yield* getSettings;
        const connector = (settings.mcpConnectors as Record<string, McpConnectorConfig>)[
          input.connectorId
        ];
        if (
          !connector ||
          connector.transport.type !== "http" ||
          connector.transport.auth.type !== "oauth"
        ) {
          return yield* fail(
            "oauth-start",
            "This connector does not use OAuth.",
            input.connectorId,
          );
        }
        const auth = connector.transport.auth;
        const base = yield* Effect.try({
          try: () => new URL(input.redirectBaseUrl),
          catch: () =>
            fail("oauth-start", "The server address is not a valid URL.", input.connectorId),
        });
        if (base.protocol !== "http:" && base.protocol !== "https:") {
          return yield* fail(
            "oauth-start",
            "OAuth sign-in needs to reach this server over http(s).",
            input.connectorId,
          );
        }
        const redirectUri = new URL(MCP_CONNECTOR_OAUTH_CALLBACK_PATH, base.origin).toString();
        const serverUrl = connector.transport.url;
        const discovery = yield* tryPromise("oauth-discovery", input.connectorId, () =>
          discoverMcpOAuth(fetchImpl, serverUrl),
        );
        const scope = auth.scopes || discovery.scopes.join(" ");
        const stored = yield* readOAuthState(input.connectorId).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        let client: McpOAuthClient;
        let registered = false;
        if (auth.clientId) {
          client = { clientId: auth.clientId };
        } else if (
          stored?.registered &&
          stored.redirectUri === redirectUri &&
          stored.issuer === discovery.authorizationServer.issuer
        ) {
          client = {
            clientId: stored.clientId,
            ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
          };
          registered = true;
        } else {
          const registrationEndpoint = discovery.authorizationServer.registrationEndpoint;
          if (!registrationEndpoint) {
            return yield* fail(
              "oauth-register",
              "This server does not support automatic client registration. Add a client id to the connector.",
              input.connectorId,
            );
          }
          client = yield* tryPromise("oauth-register", input.connectorId, () =>
            registerMcpOAuthClient(fetchImpl, {
              registrationEndpoint,
              redirectUri,
              ...(scope ? { scope } : {}),
            }),
          );
          registered = true;
        }
        const now = yield* Clock.currentTimeMillis;
        for (const [key, flow] of pendingFlows) {
          if (
            now - flow.createdAt > PENDING_FLOW_TTL_MS ||
            flow.connectorId === input.connectorId
          ) {
            pendingFlows.delete(key);
          }
        }
        const pkce = createPkcePair();
        const state = createOAuthState();
        pendingFlows.set(state, {
          connectorId: input.connectorId,
          codeVerifier: pkce.verifier,
          redirectUri,
          issuer: discovery.authorizationServer.issuer,
          tokenEndpoint: discovery.authorizationServer.tokenEndpoint,
          resource: discovery.resource,
          client,
          registered,
          createdAt: now,
        });
        return {
          authorizationUrl: buildMcpAuthorizationUrl({
            authorizationEndpoint: discovery.authorizationServer.authorizationEndpoint,
            clientId: client.clientId,
            redirectUri,
            codeChallenge: pkce.challenge,
            state,
            resource: discovery.resource,
            ...(scope ? { scope } : {}),
          }),
        };
      });

    const completeOAuth = (input: {
      readonly state: string;
      readonly code?: string;
      readonly error?: string;
      readonly errorDescription?: string;
    }) =>
      Effect.gen(function* () {
        const flow = pendingFlows.get(input.state);
        const now = yield* Clock.currentTimeMillis;
        if (!flow || now - flow.createdAt > PENDING_FLOW_TTL_MS) {
          return yield* fail(
            "oauth-callback",
            "This sign-in link has expired. Start again from Settings > Connectors.",
          );
        }
        pendingFlows.delete(input.state);
        if (input.error || !input.code) {
          return yield* fail(
            "oauth-callback",
            input.errorDescription || input.error || "The authorization server returned no code.",
            flow.connectorId,
          );
        }
        const code = input.code;
        const tokens = yield* tryPromise("oauth-token", flow.connectorId, () =>
          exchangeMcpAuthorizationCode(fetchImpl, {
            tokenEndpoint: flow.tokenEndpoint,
            client: flow.client,
            code,
            codeVerifier: flow.codeVerifier,
            redirectUri: flow.redirectUri,
            resource: flow.resource,
            now,
          }),
        );
        yield* writeOAuthState(flow.connectorId, {
          issuer: flow.issuer,
          tokenEndpoint: flow.tokenEndpoint,
          resource: flow.resource,
          redirectUri: flow.redirectUri,
          clientId: flow.client.clientId,
          ...(flow.client.clientSecret ? { clientSecret: flow.client.clientSecret } : {}),
          registered: flow.registered,
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
          ...(tokens.scope ? { scope: tokens.scope } : {}),
        });
        yield* setConnectedAt(flow.connectorId, DateTime.formatIso(DateTime.makeUnsafe(now)));
        // Verify the new token right away so the callback page and the
        // Connectors page both say whether it works.
        const check = yield* checkConnector(flow.connectorId, tokens.accessToken).pipe(
          Effect.option,
        );
        const settings = yield* getSettings;
        return {
          name:
            (settings.mcpConnectors as Record<string, McpConnectorConfig>)[flow.connectorId]
              ?.name ?? flow.connectorId,
          check: Option.getOrUndefined(check),
        };
      });

    const disconnectOAuth = (input: McpConnectorOAuthDisconnectInput) =>
      Effect.gen(function* () {
        // Under the refresh lock, so an in-flight refresh cannot write the grant back.
        yield* secretStore.remove(mcpConnectorSecretName(input.connectorId, "oauth")).pipe(
          Effect.mapError((cause) => fail("oauth-disconnect", cause.message, input.connectorId)),
          refreshLock.withPermits(1),
        );
        yield* setConnectedAt(input.connectorId, null);
        yield* updateConnector(input.connectorId, ({ lastCheck: _lastCheck, ...rest }) => rest);
      });

    const probeConnector = (connector: ResolvedMcpConnector) =>
      Effect.gen(function* () {
        const injected = options.probe;
        if (injected) return yield* Effect.promise(() => injected(connector));
        if (connector.type === "http") {
          const headers: Record<string, string> = Object.fromEntries(
            connector.headers.map((header) => [header.name, header.value]),
          );
          if (connector.bearerToken) headers.Authorization = `Bearer ${connector.bearerToken}`;
          return yield* Effect.promise(() =>
            probeMcpServer(createHttpProbeTransport(fetchImpl, connector.url, headers), {
              timeoutMs: HTTP_PROBE_TIMEOUT_MS,
            }),
          );
        }
        const env = {
          ...environment,
          ...Object.fromEntries(connector.env.map((entry) => [entry.name, entry.value])),
        };
        const spawn = yield* resolveSpawnCommand(connector.command, connector.args, { env });
        const platform = yield* HostProcessPlatform;
        return yield* Effect.promise(async (): Promise<McpProbeOutcome> => {
          try {
            const transport = createStdioProbeTransport({
              command: spawn.command,
              args: spawn.args,
              env,
              shell: spawn.shell,
              detached: platform !== "win32",
              cwd: homeDirectory,
            });
            return await probeMcpServer(transport, { timeoutMs: STDIO_PROBE_TIMEOUT_MS });
          } catch (cause) {
            return { status: "error", message: describe(cause) };
          }
        });
      });

    /** `accessToken` skips the stored-token lookup right after a sign-in. */
    const checkConnector = (connectorId: string, accessToken?: string) =>
      Effect.gen(function* () {
        const settings = yield* getSettings;
        const connector = (settings.mcpConnectors as Record<string, McpConnectorConfig>)[
          connectorId
        ];
        if (!connector) {
          return yield* fail("check", "This connector no longer exists.", connectorId);
        }
        const usesOAuth =
          connector.transport.type === "http" && connector.transport.auth.type === "oauth";
        const token = !usesOAuth
          ? undefined
          : (accessToken ??
            (yield* accessTokenFor(connectorId).pipe(Effect.orElseSucceed(() => undefined))));
        const resolved = resolveMcpConnector(connectorId as McpConnectorId, connector, token);
        const outcome: McpProbeOutcome =
          "reason" in resolved
            ? usesOAuth
              ? { status: "needs-auth", message: "Sign in to connect." }
              : connector.transport.type === "http" && connector.transport.auth.type === "bearer"
                ? { status: "needs-auth", message: "Add a token to connect." }
                : { status: "error", message: resolved.reason }
            : yield* probeConnector(resolved);
        const now = yield* Clock.currentTimeMillis;
        const check: McpConnectorCheck = {
          status: outcome.status,
          ...(outcome.status === "connected" ? { toolCount: outcome.toolCount } : {}),
          ...(outcome.status !== "connected" && outcome.message
            ? { message: outcome.message }
            : {}),
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        };
        yield* updateConnector(connectorId, (current) => ({ ...current, lastCheck: check }));
        return check;
      });

    /** Runs checks after the request that triggered them has answered. */
    const checkInBackground = (connectorIds: ReadonlyArray<string>) =>
      Effect.forEach(connectorIds, (id) => checkConnector(id).pipe(Effect.ignore), {
        concurrency: 4,
        discard: true,
      }).pipe(Effect.forkIn(serviceScope), Effect.asVoid);

    const install = (input: McpConnectorInstallInput) =>
      Effect.gen(function* () {
        const settings = yield* getSettings;
        const connectorId = connectorIdFromName(
          input.config.name,
          new Set(Object.keys(settings.mcpConnectors)),
        );
        const { lastCheck: _lastCheck, ...config } = input.config;
        yield* settingsService
          .updateSettings({ mcpConnectors: { [connectorId]: config } })
          .pipe(Effect.mapError((cause) => fail("install", cause.message, connectorId)));
        let check = yield* checkConnector(connectorId);
        // A remote server that asks for sign-in and publishes OAuth metadata
        // becomes an OAuth connector, so the next click opens its sign-in page.
        const transport = config.transport;
        if (
          check.status === "needs-auth" &&
          transport.type === "http" &&
          transport.auth.type === "none" &&
          transport.headers.length === 0
        ) {
          const supportsOAuth = yield* Effect.tryPromise(() =>
            discoverMcpOAuth(fetchImpl, transport.url),
          ).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (supportsOAuth) {
            check = { ...check, message: "Sign in to connect." };
            const signInCheck = check;
            yield* updateConnector(connectorId, (current) =>
              current.transport.type === "http"
                ? {
                    ...current,
                    transport: {
                      ...current.transport,
                      auth: { type: "oauth", scopes: "", clientId: "", connectedAt: null },
                    },
                    lastCheck: signInCheck,
                  }
                : current,
            );
          }
        }
        return { connectorId: connectorId as McpConnectorId, check };
      });

    const importAll = (input: McpConnectorImportAllInput) =>
      Effect.gen(function* () {
        const entries = yield* discoverEntries(input);
        const settings = yield* getSettings;
        const connectors: Readonly<Record<string, McpConnectorConfig>> = settings.mcpConnectors;
        const taken = new Set(Object.keys(connectors));
        const names = new Set(Object.values(connectors).map(({ name }) => name.toLowerCase()));
        const patch: Record<string, McpConnectorConfig> = {};
        const imported: McpConnectorId[] = [];
        const skipped: Array<{ name: string; reason: string }> = [];
        for (const entry of entries) {
          // The same server is often configured in more than one CLI; the first wins.
          if (names.has(entry.name.toLowerCase())) continue;
          if (!entry.connector) {
            skipped.push({ name: entry.name, reason: entry.note ?? "Cannot be imported." });
            continue;
          }
          const id = connectorIdFromName(entry.name, taken);
          taken.add(id);
          names.add(entry.name.toLowerCase());
          patch[id] = entry.connector;
          imported.push(id);
        }
        if (imported.length > 0) {
          // Real values go in; the settings service moves them into the secret store.
          yield* settingsService
            .updateSettings({ mcpConnectors: patch })
            .pipe(Effect.mapError((cause) => fail("import", cause.message)));
          yield* checkInBackground(imported);
        }
        return { imported, skipped };
      });

    const runtimes = Effect.gen(function* () {
      const env = environment as NodeJS.ProcessEnv;
      const [npx, uvx, docker] = yield* Effect.forEach(
        ["npx", "uvx", "docker"],
        (command) => isCommandAvailable(command, { env }).pipe(Effect.orElseSucceed(() => false)),
        { concurrency: "unbounded" },
      );
      return { npx: npx ?? false, uvx: uvx ?? false, docker: docker ?? false };
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const registryCache = new Map<
      string,
      { readonly at: number; readonly result: McpRegistrySearchResult }
    >();
    const searchRegistry = (input: McpRegistrySearchInput) =>
      Effect.gen(function* () {
        const key = `${input.query.trim().toLowerCase()}\u0000${input.cursor ?? ""}`;
        const now = yield* Clock.currentTimeMillis;
        const cached = registryCache.get(key);
        if (cached && now - cached.at < REGISTRY_CACHE_TTL_MS) return cached.result;
        const result = yield* Effect.tryPromise({
          try: () =>
            searchMcpRegistry(fetchImpl, {
              query: input.query,
              ...(input.cursor ? { cursor: input.cursor } : {}),
              timeoutMs: REGISTRY_TIMEOUT_MS,
            }),
          catch: (cause) =>
            fail("registry", `Could not reach the MCP Registry: ${describe(cause)}`),
        });
        if (registryCache.size >= 100) registryCache.clear();
        registryCache.set(key, { at: now, result });
        return result;
      });

    const iconCache = new Map<string, { readonly at: number; readonly icon: string | null }>();
    /**
     * Icons are fetched here, not by clients, so a remote client never loads
     * images from arbitrary origins; each one is a small PNG sent as a data URL.
     */
    const fetchIcon = async (domain: string): Promise<string | null> => {
      try {
        const response = await fetchImpl(
          `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
          { signal: AbortSignal.timeout(5_000) },
        );
        const type = response.headers.get("content-type") ?? "";
        if (!response.ok || !type.startsWith("image/")) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > ICON_MAX_BYTES) return null;
        return `data:${type.split(";")[0]};base64,${Buffer.from(bytes).toString("base64")}`;
      } catch {
        return null;
      }
    };
    const icons = (input: McpConnectorIconsInput) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const domains = [
          ...new Set(input.domains.map((domain) => domain.trim().toLowerCase())),
        ].filter((domain) => DOMAIN_PATTERN.test(domain));
        const result: Record<string, string | null> = {};
        const missing: string[] = [];
        for (const domain of domains) {
          const cached = iconCache.get(domain);
          if (cached && now - cached.at < ICON_CACHE_TTL_MS) result[domain] = cached.icon;
          else missing.push(domain);
        }
        const fetched = yield* Effect.promise(() => Promise.all(missing.map(fetchIcon)));
        missing.forEach((domain, index) => {
          const icon = fetched[index] ?? null;
          iconCache.set(domain, { at: now, icon });
          result[domain] = icon;
        });
        return { icons: result };
      });

    return McpConnectorService.of({
      resolveForSession,
      discover,
      importServer,
      startOAuth,
      completeOAuth,
      disconnectOAuth,
      importAll,
      install,
      test: (input) => checkConnector(input.connectorId),
      runtimes,
      icons,
      searchRegistry,
    });
  });

export const layer = (options?: McpConnectorServiceOptions) =>
  Layer.effect(McpConnectorService, make(options));
