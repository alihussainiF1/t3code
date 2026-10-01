import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  AUTH_RATE_LIMIT_MAX_ATTEMPTS,
  authHttpApiLayer,
  authRateLimitLayer,
  environmentAuthenticatedAuthLayer,
} from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provide(authRateLimitLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

const makeRequestContext = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedNone,
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.die("Not used by these routes."),
    remove: () => Effect.void,
  });
  return Context.make(Crypto.Crypto, crypto).pipe(
    Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
  );
});

const makeWebHandler = () => HttpRouter.toWebHandler(routesLayer, { disableLogger: true });

const withHandler = <A>(
  use: (
    handler: ReturnType<typeof makeWebHandler>["handler"],
    requestContext: Effect.Success<typeof makeRequestContext>,
  ) => Promise<A>,
) =>
  Effect.gen(function* () {
    const requestContext = yield* makeRequestContext;
    return yield* Effect.acquireUseRelease(
      Effect.sync(makeWebHandler),
      (environment) => Effect.tryPromise(() => use(environment.handler, requestContext)),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("rejects session cookies sent from a foreign origin", () =>
  withHandler(async (handler, requestContext) => {
    const devResponse = await handler(
      postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
      requestContext,
    );
    const devCookie = devResponse.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("t3_dev_session_"));
    const pairingResponse = await handler(
      postJson(
        "/api/auth/pairing-token",
        { scopes: ["orchestration:read"] },
        { cookie: devCookie?.split(";", 1)[0] ?? "" },
      ),
      requestContext,
    );
    const pairing = (await pairingResponse.json()) as { credential: string };
    const sessionResponse = await handler(
      postJson("/api/auth/browser-session", { credential: pairing.credential }),
      requestContext,
    );
    const cookie = sessionResponse.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
    expect(cookie).toMatch(/^t3_session_/);

    const ticket = (headers: Record<string, string>) =>
      handler(
        postJson("/api/auth/websocket-ticket", {}, { host: "127.0.0.1:3773", ...headers }),
        requestContext,
      );

    // Another local port is same-site, so the browser attaches the cookie.
    const foreign = await ticket({ cookie, origin: "http://127.0.0.1:4000" });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ reason: "cross_origin_request" });
    expect((await ticket({ cookie, origin: "null" })).status).toBe(403);

    expect((await ticket({ cookie, origin: "http://127.0.0.1:3773" })).status).toBe(200);
    expect((await ticket({ cookie })).status).toBe(200);
    // Tailscale serve keeps the public authority in X-Forwarded-Host.
    expect(
      (
        await ticket({
          cookie,
          origin: "https://box.tail1234.ts.net",
          "x-forwarded-host": "box.tail1234.ts.net",
        })
      ).status,
    ).toBe(200);
    // Dev: the Vite page proxies with a rewritten Host.
    expect((await ticket({ cookie, origin: "http://localhost:5173" })).status).toBe(200);
    // Bearer credentials are deliberate, so any origin may present them.
    expect(
      (await ticket({ authorization: `Bearer ${DEV_TOKEN}`, origin: "https://app.t3.codes" }))
        .status,
    ).toBe(200);

    const foreignSession = await handler(
      new Request("http://127.0.0.1/api/auth/session", {
        headers: { cookie, host: "127.0.0.1:3773", origin: "http://127.0.0.1:4000" },
      }),
      requestContext,
    );
    expect(await foreignSession.json()).toMatchObject({ authenticated: false });
  }),
);

it.effect("rate limits unauthenticated credential exchanges", () =>
  withHandler(async (handler, requestContext) => {
    const attempt = () =>
      handler(
        postJson("/api/auth/browser-session", { credential: "not-a-credential" }),
        requestContext,
      );
    for (let index = 0; index < AUTH_RATE_LIMIT_MAX_ATTEMPTS; index++) {
      expect((await attempt()).status).toBe(401);
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // The limit covers the token exchange too, and spares authenticated routes.
    const tokenExchange = await handler(
      new Request("http://127.0.0.1/oauth/token", { method: "POST" }),
      requestContext,
    );
    expect(tokenExchange.status).toBe(429);
    const session = await handler(new Request("http://127.0.0.1/api/auth/session"), requestContext);
    expect(session.status).toBe(200);
  }),
);

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const requestContext = yield* makeRequestContext;
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
