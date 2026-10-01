import { describe, expect, it } from "vite-plus/test";

import {
  authorizationServerMetadataUrls,
  buildMcpAuthorizationUrl,
  canonicalResourceUri,
  createPkcePair,
  discoverMcpOAuth,
  exchangeMcpAuthorizationCode,
  type FetchLike,
  parseBearerChallenge,
  pkceChallenge,
  protectedResourceMetadataUrls,
  refreshMcpAccessToken,
  registerMcpOAuthClient,
  shouldRefreshMcpToken,
} from "./McpOAuth.ts";

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly headers: Record<string, string>;
}

/** A fetch that answers from a URL table and records every request. */
function fakeFetch(
  routes: Record<string, (request: Recorded) => Response>,
): FetchLike & { readonly requests: Recorded[] } {
  const requests: Recorded[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const request: Recorded = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : init?.body?.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    requests.push(request);
    const route = routes[`${request.method} ${url}`];
    return route ? route(request) : new Response("not found", { status: 404 });
  };
  return Object.assign(impl, { requests });
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

const asMetadata = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  code_challenge_methods_supported: ["S256"],
};

describe("PKCE", () => {
  it("derives the RFC 7636 S256 challenge", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(pkceChallenge(pair.verifier));
  });
});

describe("metadata URLs", () => {
  it("parses Bearer challenges with quoted and bare values", () => {
    expect(
      parseBearerChallenge(
        'Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope=files:read',
      ),
    ).toEqual({
      realm: "mcp",
      resource_metadata: "https://mcp.example.com/.well-known/oauth-protected-resource",
      scope: "files:read",
    });
    expect(parseBearerChallenge('Basic realm="x"')).toEqual({});
  });

  it("orders well-known locations as the specs require", () => {
    expect(protectedResourceMetadataUrls("https://mcp.example.com/v1/mcp")).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
    expect(authorizationServerMetadataUrls("https://auth.example.com/tenant")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
      "https://auth.example.com/.well-known/openid-configuration/tenant",
      "https://auth.example.com/tenant/.well-known/openid-configuration",
    ]);
    expect(canonicalResourceUri("https://mcp.example.com/")).toBe("https://mcp.example.com");
    expect(canonicalResourceUri("https://mcp.example.com/mcp#x")).toBe(
      "https://mcp.example.com/mcp",
    );
  });
});

describe("discoverMcpOAuth", () => {
  it("follows the WWW-Authenticate challenge to the authorization server", async () => {
    const fetch = fakeFetch({
      "POST https://mcp.example.com/mcp": () =>
        new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.com/meta", scope="read write"',
          },
        }),
      "GET https://mcp.example.com/meta": () =>
        json({
          resource: "https://mcp.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
        }),
      "GET https://auth.example.com/.well-known/oauth-authorization-server": () => json(asMetadata),
    });
    const discovery = await discoverMcpOAuth(fetch, "https://mcp.example.com/mcp");
    expect(discovery).toEqual({
      resource: "https://mcp.example.com/mcp",
      authorizationServer: {
        issuer: "https://auth.example.com",
        authorizationEndpoint: "https://auth.example.com/authorize",
        tokenEndpoint: "https://auth.example.com/token",
        registrationEndpoint: "https://auth.example.com/register",
      },
      scopes: ["read", "write"],
    });
  });

  it("falls back to the server's own origin for servers without resource metadata", async () => {
    const fetch = fakeFetch({
      "GET https://legacy.example.com/.well-known/openid-configuration": () =>
        json({ ...asMetadata, issuer: "https://legacy.example.com" }),
    });
    const discovery = await discoverMcpOAuth(fetch, "https://legacy.example.com/mcp");
    expect(discovery.authorizationServer.issuer).toBe("https://legacy.example.com");
  });

  it("rejects authorization servers that do not offer S256", async () => {
    const fetch = fakeFetch({
      "GET https://mcp.example.com/.well-known/oauth-authorization-server": () =>
        json({ ...asMetadata, code_challenge_methods_supported: ["plain"] }),
    });
    await expect(discoverMcpOAuth(fetch, "https://mcp.example.com/mcp")).rejects.toThrow(
      /Could not find OAuth metadata/,
    );
  });
});

describe("client registration and tokens", () => {
  it("registers a public client for the redirect URI", async () => {
    const fetch = fakeFetch({
      "POST https://auth.example.com/register": () => json({ client_id: "c1" }, { status: 201 }),
    });
    const client = await registerMcpOAuthClient(fetch, {
      registrationEndpoint: "https://auth.example.com/register",
      redirectUri: "http://localhost:3774/oauth/mcp-connectors/callback",
    });
    expect(client).toEqual({ clientId: "c1" });
    expect(JSON.parse(fetch.requests[0]!.body!)).toMatchObject({
      redirect_uris: ["http://localhost:3774/oauth/mcp-connectors/callback"],
      token_endpoint_auth_method: "none",
    });
  });

  it("builds the authorization URL with PKCE, state, and resource", () => {
    const url = new URL(
      buildMcpAuthorizationUrl({
        authorizationEndpoint: "https://auth.example.com/authorize?prompt=consent",
        clientId: "c1",
        redirectUri: "http://localhost/cb",
        codeChallenge: "chal",
        state: "st",
        resource: "https://mcp.example.com/mcp",
        scope: "read",
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prompt: "consent",
      response_type: "code",
      client_id: "c1",
      redirect_uri: "http://localhost/cb",
      code_challenge: "chal",
      code_challenge_method: "S256",
      state: "st",
      resource: "https://mcp.example.com/mcp",
      scope: "read",
    });
  });

  it("exchanges the code and keeps the refresh token across non-rotating refreshes", async () => {
    const fetch = fakeFetch({
      "POST https://auth.example.com/token": (request) => {
        const params = new URLSearchParams(request.body);
        return params.get("grant_type") === "authorization_code"
          ? json({ access_token: "a1", refresh_token: "r1", expires_in: 3600 })
          : json({ access_token: "a2", expires_in: 3600 });
      },
    });
    const tokens = await exchangeMcpAuthorizationCode(fetch, {
      tokenEndpoint: "https://auth.example.com/token",
      client: { clientId: "c1" },
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "http://localhost/cb",
      resource: "https://mcp.example.com/mcp",
      now: 1_000,
    });
    expect(tokens).toEqual({ accessToken: "a1", refreshToken: "r1", expiresAt: 3_601_000 });
    expect(Object.fromEntries(new URLSearchParams(fetch.requests[0]!.body))).toEqual({
      grant_type: "authorization_code",
      code: "code",
      code_verifier: "verifier",
      redirect_uri: "http://localhost/cb",
      resource: "https://mcp.example.com/mcp",
      client_id: "c1",
    });

    const refreshed = await refreshMcpAccessToken(fetch, {
      tokenEndpoint: "https://auth.example.com/token",
      client: { clientId: "c1" },
      refreshToken: "r1",
      resource: "https://mcp.example.com/mcp",
      now: 2_000,
    });
    expect(refreshed).toEqual({ accessToken: "a2", refreshToken: "r1", expiresAt: 3_602_000 });
  });

  it("surfaces the server's error description", async () => {
    const fetch = fakeFetch({
      "POST https://auth.example.com/token": () =>
        json({ error: "invalid_grant", error_description: "Code expired" }, { status: 400 }),
    });
    await expect(
      exchangeMcpAuthorizationCode(fetch, {
        tokenEndpoint: "https://auth.example.com/token",
        client: { clientId: "c1" },
        code: "code",
        codeVerifier: "v",
        redirectUri: "http://localhost/cb",
        resource: "r",
        now: 0,
      }),
    ).rejects.toThrow("Token request failed (400): Code expired.");
  });

  it("refreshes only when the token is close to expiry", () => {
    expect(shouldRefreshMcpToken({ accessToken: "a" }, 0)).toBe(false);
    expect(shouldRefreshMcpToken({ accessToken: "a", expiresAt: 10 * 60_000 }, 0)).toBe(false);
    expect(shouldRefreshMcpToken({ accessToken: "a", expiresAt: 4 * 60_000 }, 0)).toBe(true);
  });
});
