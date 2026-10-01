/**
 * OAuth helpers for remote MCP connectors, following the MCP authorization
 * spec: protected resource metadata (RFC 9728), authorization server
 * metadata (RFC 8414 / OIDC discovery), dynamic client registration
 * (RFC 7591), and the authorization code flow with PKCE (S256) and resource
 * indicators (RFC 8707).
 *
 * Plain async functions over an injected `fetch`, so the flow is testable
 * with canned responses and the Effect service only orchestrates.
 *
 * @module McpOAuth
 */
import * as NodeCrypto from "node:crypto";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface McpAuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly scopesSupported?: ReadonlyArray<string>;
}

export interface McpOAuthDiscovery {
  /** Canonical resource URI sent as `resource` on authorize and token requests. */
  readonly resource: string;
  readonly authorizationServer: McpAuthorizationServerMetadata;
  /** Scopes the resource asked for in its challenge or metadata. */
  readonly scopes: ReadonlyArray<string>;
}

export interface McpOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch millis; absent when the server did not say. */
  readonly expiresAt?: number;
  readonly scope?: string;
}

export class McpOAuthError extends Error {
  override readonly name = "McpOAuthError";
}

const base64Url = (bytes: Buffer) => bytes.toString("base64url");

export function createPkcePair(): { readonly verifier: string; readonly challenge: string } {
  const verifier = base64Url(NodeCrypto.randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return base64Url(NodeCrypto.createHash("sha256").update(verifier).digest());
}

export function createOAuthState(): string {
  return base64Url(NodeCrypto.randomBytes(24));
}

/**
 * Parameters of a `WWW-Authenticate: Bearer ...` challenge. Only the Bearer
 * scheme is read; quoted and token values are both accepted.
 */
export function parseBearerChallenge(header: string | null | undefined): Record<string, string> {
  if (!header) return {};
  const match = /(?:^|,)\s*Bearer\b(.*)$/i.exec(header);
  if (!match) return {};
  const params: Record<string, string> = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const part of (match[1] ?? "").matchAll(pattern)) {
    const key = part[1];
    if (!key) continue;
    params[key.toLowerCase()] = (part[2] ?? part[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return params;
}

/** The resource URI for an MCP server URL: no fragment, no trailing slash on the root. */
export function canonicalResourceUri(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = "";
  const text = url.toString();
  return url.pathname === "/" && !url.search ? text.replace(/\/$/, "") : text;
}

/** RFC 8414 well-known URLs for an issuer, then the OIDC variants the MCP spec also accepts. */
export function authorizationServerMetadataUrls(issuer: string): ReadonlyArray<string> {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  const origin = url.origin;
  if (path === "") {
    return [
      `${origin}/.well-known/oauth-authorization-server`,
      `${origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
}

/** RFC 9728 well-known URLs for a resource: path-specific first, then the origin. */
export function protectedResourceMetadataUrls(serverUrl: string): ReadonlyArray<string> {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/$/, "");
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  return path === "" ? [root] : [`${root}${path}`, root];
}

async function readJson(fetchImpl: FetchLike, url: string): Promise<unknown | undefined> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const asString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const asStrings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

function parseAuthorizationServerMetadata(
  value: unknown,
): McpAuthorizationServerMetadata | undefined {
  const record = asRecord(value);
  const issuer = asString(record?.issuer);
  const authorizationEndpoint = asString(record?.authorization_endpoint);
  const tokenEndpoint = asString(record?.token_endpoint);
  if (!record || !issuer || !authorizationEndpoint || !tokenEndpoint) return undefined;
  const methods = asStrings(record.code_challenge_methods_supported);
  // The MCP spec requires S256; refuse servers that explicitly lack it.
  if (methods && !methods.includes("S256")) return undefined;
  const registrationEndpoint = asString(record.registration_endpoint);
  const scopesSupported = asStrings(record.scopes_supported);
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(scopesSupported ? { scopesSupported } : {}),
  };
}

/**
 * Finds the authorization server for an MCP server. Probes the server
 * unauthenticated for a `WWW-Authenticate` challenge naming its resource
 * metadata, falls back to the well-known metadata URLs, and finally treats
 * the server's own origin as the authorization server (older servers that
 * predate protected resource metadata).
 */
export async function discoverMcpOAuth(
  fetchImpl: FetchLike,
  serverUrl: string,
): Promise<McpOAuthDiscovery> {
  const resource = canonicalResourceUri(serverUrl);
  let challenge: Record<string, string> = {};
  try {
    const probe = await fetchImpl(serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t3-code", version: "0.0.0" },
        },
      }),
    });
    if (probe.status === 401 || probe.status === 403) {
      challenge = parseBearerChallenge(probe.headers.get("www-authenticate"));
    }
  } catch {
    // Unreachable servers still get the well-known attempts below.
  }

  const resourceMetadataUrls = challenge.resource_metadata
    ? [challenge.resource_metadata, ...protectedResourceMetadataUrls(serverUrl)]
    : protectedResourceMetadataUrls(serverUrl);
  let authorizationServers: ReadonlyArray<string> = [];
  let metadataScopes: ReadonlyArray<string> = [];
  for (const url of resourceMetadataUrls) {
    const metadata = asRecord(await readJson(fetchImpl, url).catch(() => undefined));
    const servers = asStrings(metadata?.authorization_servers);
    if (servers && servers.length > 0) {
      authorizationServers = servers;
      metadataScopes = asStrings(metadata?.scopes_supported) ?? [];
      break;
    }
  }
  if (authorizationServers.length === 0) authorizationServers = [new URL(serverUrl).origin];

  for (const issuer of authorizationServers) {
    for (const url of authorizationServerMetadataUrls(issuer)) {
      const metadata = parseAuthorizationServerMetadata(
        await readJson(fetchImpl, url).catch(() => undefined),
      );
      if (metadata) {
        const scopes = challenge.scope
          ? challenge.scope.split(/\s+/).filter(Boolean)
          : metadataScopes;
        return { resource, authorizationServer: metadata, scopes };
      }
    }
  }
  throw new McpOAuthError(
    `Could not find OAuth metadata for ${new URL(serverUrl).origin}. The server may not support OAuth sign-in.`,
  );
}

export interface McpOAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string;
}

/** RFC 7591 registration of T3 as a public client for one redirect URI. */
export async function registerMcpOAuthClient(
  fetchImpl: FetchLike,
  input: {
    readonly registrationEndpoint: string;
    readonly redirectUri: string;
    readonly scope?: string;
  },
): Promise<McpOAuthClient> {
  const response = await fetchImpl(input.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "T3 Code",
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(input.scope ? { scope: input.scope } : {}),
    }),
  });
  const body = asRecord(await response.json().catch(() => undefined));
  const clientId = asString(body?.client_id);
  if (!response.ok || !clientId) {
    throw new McpOAuthError(
      `Client registration failed (${response.status})${body?.error_description ? `: ${String(body.error_description)}` : ""}.`,
    );
  }
  const clientSecret = asString(body?.client_secret);
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

export function buildMcpAuthorizationUrl(input: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly resource: string;
  readonly scope?: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("resource", input.resource);
  if (input.scope) url.searchParams.set("scope", input.scope);
  return url.toString();
}

async function requestTokens(
  fetchImpl: FetchLike,
  tokenEndpoint: string,
  client: McpOAuthClient,
  params: Record<string, string>,
  now: number,
): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(
      `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`,
    ).toString("base64")}`;
  }
  const response = await fetchImpl(tokenEndpoint, { method: "POST", headers, body });
  const json = asRecord(await response.json().catch(() => undefined));
  const accessToken = asString(json?.access_token);
  if (!response.ok || !accessToken) {
    const reason = asString(json?.error_description) ?? asString(json?.error);
    throw new McpOAuthError(
      `Token request failed (${response.status})${reason ? `: ${reason}` : ""}.`,
    );
  }
  const refreshToken = asString(json?.refresh_token);
  const expiresIn =
    typeof json?.expires_in === "number" ? json.expires_in : Number(json?.expires_in);
  const scope = asString(json?.scope);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(scope ? { scope } : {}),
  };
}

export function exchangeMcpAuthorizationCode(
  fetchImpl: FetchLike,
  input: {
    readonly tokenEndpoint: string;
    readonly client: McpOAuthClient;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly resource: string;
    readonly now: number;
  },
): Promise<McpOAuthTokens> {
  return requestTokens(
    fetchImpl,
    input.tokenEndpoint,
    input.client,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      resource: input.resource,
    },
    input.now,
  );
}

/** A refresh keeps the old refresh token when the server does not rotate it. */
export async function refreshMcpAccessToken(
  fetchImpl: FetchLike,
  input: {
    readonly tokenEndpoint: string;
    readonly client: McpOAuthClient;
    readonly refreshToken: string;
    readonly resource: string;
    readonly now: number;
  },
): Promise<McpOAuthTokens> {
  const tokens = await requestTokens(
    fetchImpl,
    input.tokenEndpoint,
    input.client,
    { grant_type: "refresh_token", refresh_token: input.refreshToken, resource: input.resource },
    input.now,
  );
  return tokens.refreshToken ? tokens : { ...tokens, refreshToken: input.refreshToken };
}

/** Refresh when the token expires within this window, so a session never starts on a dying token. */
export const MCP_OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;

export function shouldRefreshMcpToken(tokens: McpOAuthTokens, now: number): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt - now <= MCP_OAUTH_REFRESH_SKEW_MS;
}
