import * as NodeServices from "@effect/platform-node/NodeServices";
import { McpConnectorId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const MARKER = "••••••";
const github = McpConnectorId.make("github");
const linear = McpConnectorId.make("linear");

const makeLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-mcp-connectors-test-" })),
    ),
  );

const readSecret = (name: string) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const value = yield* secrets.get(name);
    return Option.isSome(value) ? new TextDecoder().decode(value.value) : undefined;
  });

it.layer(NodeServices.layer)("server settings: MCP connectors", (it) => {
  it.effect("keeps connector secrets in the secret store and redacts them to clients", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      const next = yield* settings.updateSettings({
        mcpConnectors: {
          [github]: {
            name: "GitHub",
            enabled: true,
            transport: {
              type: "stdio",
              command: "github-mcp",
              args: ["stdio"],
              env: [
                { name: "GITHUB_TOKEN", value: "ghp_secret", secret: true },
                { name: "LOG_LEVEL", value: "info", secret: false },
              ],
            },
          },
          [linear]: {
            name: "Linear",
            enabled: true,
            transport: {
              type: "http",
              url: "https://mcp.linear.app/mcp",
              headers: [{ name: "X-Team", value: "team-secret", secret: true }],
              auth: { type: "bearer", token: "lin_secret" },
            },
          },
        },
      });

      // Server-side readers get the real values.
      const githubEnv =
        next.mcpConnectors[github]?.transport.type === "stdio"
          ? next.mcpConnectors[github].transport.env
          : [];
      assert.deepEqual(githubEnv[0]?.value, "ghp_secret");

      const raw = yield* fileSystem.readFileString(config.settingsPath);
      for (const secret of ["ghp_secret", "team-secret", "lin_secret"]) {
        assert.notInclude(raw, secret);
      }
      assert.include(raw, "info");
      assert.equal(
        yield* readSecret(ServerSettingsModule.mcpConnectorSecretName("linear", "bearer")),
        "lin_secret",
      );

      const redacted = ServerSettingsModule.redactServerSettingsForClient(next);
      const linearTransport = redacted.mcpConnectors[linear]?.transport;
      assert.equal(linearTransport?.type, "http");
      if (linearTransport?.type === "http") {
        assert.equal(linearTransport.headers[0]?.value, MARKER);
        assert.deepEqual(linearTransport.auth, { type: "bearer", token: MARKER });
      }
      const githubTransport = redacted.mcpConnectors[github]?.transport;
      if (githubTransport?.type === "stdio") {
        assert.deepEqual(
          githubTransport.env.map((entry) => entry.value),
          [MARKER, "info"],
        );
      }

      // A client echoing the redacted entry back keeps the stored secrets.
      const echoed = yield* settings.updateSettings({
        mcpConnectors: { [linear]: { ...redacted.mcpConnectors[linear]!, name: "Linear (work)" } },
      });
      const echoedTransport = echoed.mcpConnectors[linear]?.transport;
      assert.equal(echoed.mcpConnectors[linear]?.name, "Linear (work)");
      if (echoedTransport?.type === "http") {
        assert.deepEqual(echoedTransport.auth, { type: "bearer", token: "lin_secret" });
        assert.equal(echoedTransport.headers[0]?.value, "team-secret");
      }
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("removes a connector's secrets and OAuth tokens when it is deleted", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* settings.updateSettings({
        mcpConnectors: {
          [linear]: {
            name: "Linear",
            enabled: true,
            transport: {
              type: "http",
              url: "https://mcp.linear.app/mcp",
              headers: [{ name: "X-Team", value: "team-secret", secret: true }],
              auth: { type: "oauth", scopes: "", clientId: "", connectedAt: null },
            },
          },
        },
      });
      const oauthName = ServerSettingsModule.mcpConnectorSecretName("linear", "oauth");
      yield* secrets.set(oauthName, new TextEncoder().encode('{"accessToken":"a"}'));

      const next = yield* settings.updateSettings({ mcpConnectors: { [linear]: null } });

      assert.deepEqual(Object.keys(next.mcpConnectors), []);
      assert.equal(yield* readSecret(oauthName), undefined);
      assert.equal(
        yield* readSecret(
          ServerSettingsModule.mcpConnectorSecretName("linear", "header", "X-Team"),
        ),
        undefined,
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("clears a secret when the client sends an empty value", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const connector = {
        name: "Remote",
        enabled: true,
        transport: {
          type: "http" as const,
          url: "https://example.com/mcp",
          headers: [],
          auth: { type: "bearer" as const, token: "tok" },
        },
      };
      yield* settings.updateSettings({ mcpConnectors: { [linear]: connector } });
      const cleared = yield* settings.updateSettings({
        mcpConnectors: {
          [linear]: {
            ...connector,
            transport: { ...connector.transport, auth: { type: "bearer", token: "" } },
          },
        },
      });
      const transport = cleared.mcpConnectors[linear]?.transport;
      assert.deepEqual(transport?.type === "http" ? transport.auth : undefined, {
        type: "bearer",
        token: "",
      });
      assert.equal(
        yield* readSecret(ServerSettingsModule.mcpConnectorSecretName("linear", "bearer")),
        undefined,
      );
    }).pipe(Effect.provide(makeLayer())),
  );
});
