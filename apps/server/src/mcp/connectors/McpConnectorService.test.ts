import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpConnectorId, ProviderDriverKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import * as McpConnectorService from "./McpConnectorService.ts";
import type { McpProbeOutcome } from "./McpConnectorProbe.ts";
import type { ResolvedMcpConnector } from "./McpConnectorTranslators.ts";
import type { FetchLike } from "./McpOAuth.ts";

const linear = McpConnectorId.make("linear");
const codex = ProviderDriverKind.make("codex");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An MCP server plus authorization server that issue short-lived, refreshable tokens. */
function makeAuthServer() {
  let issued = 0;
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url === "https://mcp.example.com/mcp") {
      return new Response("", {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/prm"' },
      });
    }
    if (url === "https://mcp.example.com/prm") {
      return json({ authorization_servers: ["https://auth.example.com"] });
    }
    if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
      });
    }
    if (url === "https://auth.example.com/register") return json({ client_id: "registered" }, 201);
    if (url === "https://auth.example.com/token") {
      issued += 1;
      // Expires inside the refresh window, so the next session start refreshes it.
      return json({ access_token: `access-${issued}`, refresh_token: "refresh", expires_in: 60 });
    }
    return new Response("", { status: 404 });
  };
  return { fetch };
}

const makeLayer = (
  fetch: FetchLike,
  extra: Pick<McpConnectorService.McpConnectorServiceOptions, "homeDirectory" | "probe"> = {},
) => {
  const settings = ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mcp-service-test-" })),
    ),
  );
  return McpConnectorService.layer({
    fetch,
    environment: {},
    homeDirectory: "/nonexistent",
    probe: async () => ({ status: "error", message: "No probe in this test." }),
    ...extra,
  }).pipe(Layer.provideMerge(settings));
};

it.layer(NodeServices.layer)("McpConnectorService", (it) => {
  it.effect("connects an OAuth connector and hands every session a fresh token", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const service = yield* McpConnectorService.McpConnectorService;
      yield* settings.updateSettings({
        mcpConnectors: {
          [linear]: {
            name: "Linear",
            enabled: true,
            transport: {
              type: "http",
              url: "https://mcp.example.com/mcp",
              headers: [],
              auth: { type: "oauth", scopes: "", clientId: "", connectedAt: null },
            },
          },
        },
      });

      // Not connected yet: the connector is left out rather than failing the session.
      assert.deepEqual(
        yield* service.resolveForSession({ provider: codex, disabledForThread: [] }),
        [],
      );

      const { authorizationUrl } = yield* service.startOAuth({
        connectorId: linear,
        redirectBaseUrl: "http://localhost:3774/settings/connectors",
      });
      const authorize = new URL(authorizationUrl);
      assert.equal(authorize.origin + authorize.pathname, "https://auth.example.com/authorize");
      assert.equal(authorize.searchParams.get("client_id"), "registered");
      assert.equal(
        authorize.searchParams.get("redirect_uri"),
        "http://localhost:3774/oauth/mcp-connectors/callback",
      );

      const completed = yield* service.completeOAuth({
        state: authorize.searchParams.get("state")!,
        code: "the-code",
      });
      assert.equal(completed.name, "Linear");
      // The new token is checked right away, with the token the flow just received.
      assert.deepInclude(completed.check, { status: "connected", toolCount: 2 });
      const connected = yield* settings.getSettings;
      const transport = connected.mcpConnectors[linear]?.transport;
      assert.isTrue(
        transport?.type === "http" &&
          transport.auth.type === "oauth" &&
          transport.auth.connectedAt !== null,
      );

      // The stored token is inside the refresh window, so starting a session refreshes it.
      const resolved = yield* service.resolveForSession({ provider: codex, disabledForThread: [] });
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]?.type === "http" ? resolved[0].bearerToken : undefined, "access-2");

      // A thread opt-out leaves it out again.
      assert.deepEqual(
        yield* service.resolveForSession({ provider: codex, disabledForThread: [linear] }),
        [],
      );

      // A replayed state is rejected.
      const replay = yield* service
        .completeOAuth({ state: authorize.searchParams.get("state")!, code: "the-code" })
        .pipe(Effect.flip);
      assert.include(replay.detail, "expired");

      yield* service.disconnectOAuth({ connectorId: linear });
      const disconnected = yield* settings.getSettings;
      const after = disconnected.mcpConnectors[linear]?.transport;
      assert.isTrue(
        after?.type === "http" && after.auth.type === "oauth" && after.auth.connectedAt === null,
      );
      assert.deepEqual(
        yield* service.resolveForSession({ provider: codex, disabledForThread: [] }),
        [],
      );
    }).pipe(Effect.provide(makeLayer(makeAuthServer().fetch, { probe }))),
  );

  const probed: string[] = [];
  const probe = async (connector: ResolvedMcpConnector): Promise<McpProbeOutcome> => {
    probed.push(connector.id);
    if (connector.type === "stdio") return { status: "connected", toolCount: 5 };
    return connector.bearerToken
      ? { status: "connected", toolCount: 2 }
      : { status: "needs-auth", message: "The server needs you to sign in." };
  };

  it.effect("adds a connector, checks it, and records the result", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const service = yield* McpConnectorService.McpConnectorService;
      probed.length = 0;

      const local = yield* service.install({
        config: {
          name: "Memory",
          enabled: true,
          catalogId: "builtin:memory",
          transport: { type: "stdio", command: "npx", args: ["-y", "memory"], env: [] },
        },
      });
      assert.equal(local.connectorId, "memory");
      assert.deepInclude(local.check, { status: "connected", toolCount: 5 });
      const saved = (yield* settings.getSettings).mcpConnectors[local.connectorId];
      assert.equal(saved?.lastCheck?.status, "connected");
      assert.equal(saved?.catalogId, "builtin:memory");

      // A remote that answers 401 and publishes OAuth metadata becomes an OAuth connector.
      const remote = yield* service.install({
        config: {
          name: "Example",
          enabled: true,
          transport: {
            type: "http",
            url: "https://mcp.example.com/mcp",
            headers: [],
            auth: { type: "none" },
          },
        },
      });
      assert.equal(remote.check.status, "needs-auth");
      const converted = (yield* settings.getSettings).mcpConnectors[remote.connectorId];
      assert.isTrue(
        converted?.transport.type === "http" && converted.transport.auth.type === "oauth",
      );

      // Without a token the check answers needs-auth without contacting the server.
      probed.length = 0;
      const recheck = yield* service.test({ connectorId: remote.connectorId });
      assert.deepEqual(
        { status: recheck.status, message: recheck.message },
        { status: "needs-auth", message: "Sign in to connect." },
      );
      assert.deepEqual(probed, []);

      const missing = yield* service
        .test({ connectorId: McpConnectorId.make("nope") })
        .pipe(Effect.flip);
      assert.include(missing.detail, "no longer exists");
    }).pipe(Effect.provide(makeLayer(makeAuthServer().fetch, { probe }))),
  );

  it.effect("imports every discovered server once, secrets into the store", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-import-" });
      yield* fileSystem.makeDirectory(`${home}/.codex`);
      yield* fileSystem.writeFileString(
        `${home}/.codex/config.toml`,
        [
          "[mcp_servers.alpha]",
          'command = "npx"',
          'env = { API_KEY = "k-1" }',
          "[mcp_servers.beta]",
          'url = "https://beta.example.com/mcp"',
        ].join("\n"),
      );
      yield* fileSystem.writeFileString(
        `${home}/.claude.json`,
        `{"mcpServers": {
          "alpha": { "command": "other" },
          "gamma": { "command": "uvx", "args": ["gamma"] },
          "legacy": { "type": "sse", "url": "https://legacy.example.com/sse" }
        }}`,
      );
      return yield* Effect.gen(function* () {
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const service = yield* McpConnectorService.McpConnectorService;
        yield* settings.updateSettings({
          mcpConnectors: {
            [McpConnectorId.make("beta")]: {
              name: "Beta",
              enabled: true,
              transport: {
                type: "http",
                url: "https://beta.example.com/mcp",
                headers: [],
                auth: { type: "none" },
              },
            },
          },
        });

        const result = yield* service.importAll({});
        assert.deepEqual([...result.imported], ["alpha", "gamma"]);
        assert.deepEqual(
          result.skipped.map(({ name }) => name),
          ["legacy"],
        );
        const alpha = (yield* settings.getSettings).mcpConnectors[McpConnectorId.make("alpha")];
        assert.deepEqual(alpha?.transport.type === "stdio" ? alpha.transport.env : [], [
          { name: "API_KEY", value: "k-1", secret: true },
        ]);
        const stored = yield* secrets.get(
          ServerSettingsModule.mcpConnectorSecretName("alpha", "env", "API_KEY"),
        );
        assert.equal(
          Option.isSome(stored) ? new TextDecoder().decode(stored.value) : undefined,
          "k-1",
        );

        // Running it again finds nothing new.
        assert.deepEqual((yield* service.importAll({})).imported, []);
      }).pipe(Effect.provide(makeLayer(makeAuthServer().fetch, { homeDirectory: home, probe })));
    }).pipe(Effect.scoped),
  );
});
