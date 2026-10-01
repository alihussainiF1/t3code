import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpConnectorId, ProviderDriverKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import * as McpConnectorService from "./McpConnectorService.ts";
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

const makeLayer = (fetch: FetchLike) => {
  const settings = ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mcp-service-test-" })),
    ),
  );
  return McpConnectorService.layer({ fetch, environment: {}, homeDirectory: "/nonexistent" }).pipe(
    Layer.provideMerge(settings),
  );
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

      const name = yield* service.completeOAuth({
        state: authorize.searchParams.get("state")!,
        code: "the-code",
      });
      assert.equal(name, "Linear");
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
    }).pipe(Effect.provide(makeLayer(makeAuthServer().fetch))),
  );
});
