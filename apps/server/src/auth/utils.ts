import type {
  AuthClientMetadata,
  AuthClientMetadataDeviceType,
  AuthClientPresentationMetadata,
} from "@t3tools/contracts";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as NodeCrypto from "node:crypto";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";

const SESSION_COOKIE_NAME = "t3_session";

/**
 * Cookies are scoped by host but *not* by port, so any two servers that can be
 * live on one hostname at once need separate names — otherwise the second
 * clobbers the first's session and both sides see "Invalid session token
 * signature" until someone clears cookies by hand.
 *
 * Remote web servers use their persisted environment identity and omit the
 * port, so the name survives state-directory moves and public port changes.
 *
 * Desktop scans upward from 3773 for a free port and binds
 *   127.0.0.1, so a second instance lands on a different port and the same host.
 */
export function resolveSessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly port: number;
  readonly host: string | undefined;
  readonly instanceKey: string;
  readonly environmentId: string;
  readonly development: boolean;
}): string {
  if (input.mode === "desktop") {
    return `${SESSION_COOKIE_NAME}_${input.port}`;
  }

  const instanceHash = NodeCrypto.createHash("sha256")
    .update(
      !input.development && isRemoteReachableHost(input.host)
        ? input.environmentId
        : input.instanceKey,
    )
    .digest("hex")
    .slice(0, 12);

  if (!input.development && isRemoteReachableHost(input.host)) {
    return `${SESSION_COOKIE_NAME}_${instanceHash}`;
  }

  // Cookies are scoped by host, not port. Loopback development servers need an
  // instance-specific name or parallel agents overwrite each other's session,
  // and a server that later reuses the port receives a token signed elsewhere.
  return `${SESSION_COOKIE_NAME}_${input.port}_${instanceHash}`;
}

export function resolveLegacySessionCookieName(input: {
  readonly mode: "web" | "desktop";
  readonly host: string | undefined;
  readonly development: boolean;
}): string | undefined {
  return input.mode === "web" && !input.development && isRemoteReachableHost(input.host)
    ? SESSION_COOKIE_NAME
    : undefined;
}

export function isRemoteReachableHost(host: string | undefined): boolean {
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    return true;
  }
  if (!host || host.length === 0) {
    return false;
  }
  return !(
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

export function base64UrlEncode(input: string | Uint8Array): string {
  return typeof input === "string"
    ? Encoding.encodeBase64Url(new TextEncoder().encode(input))
    : Encoding.encodeBase64Url(input);
}

export function base64UrlDecodeUtf8(input: string): string {
  return Result.getOrThrow(Encoding.decodeBase64UrlString(input));
}

export function signPayload(payload: string, secret: Uint8Array): string {
  return NodeCrypto.createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url");
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIpAddress(value: string | null | undefined): string | undefined {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function inferDeviceType(userAgent: string | undefined): AuthClientMetadataDeviceType {
  if (!userAgent) {
    return "unknown";
  }

  const normalized = userAgent.toLowerCase();
  if (/bot|crawler|spider|slurp|curl|wget/.test(normalized)) {
    return "bot";
  }
  if (/ipad|tablet/.test(normalized)) {
    return "tablet";
  }
  if (/iphone|android.+mobile|mobile/.test(normalized)) {
    return "mobile";
  }
  return "desktop";
}

function inferBrowser(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const normalized = userAgent.toLowerCase();
  if (/edg\//.test(normalized)) return "Edge";
  if (/opr\//.test(normalized)) return "Opera";
  if (/firefox\//.test(normalized)) return "Firefox";
  if (/electron\//.test(normalized)) return "Electron";
  if (/chrome\//.test(normalized) || /crios\//.test(normalized)) return "Chrome";
  if (/safari\//.test(normalized) && !/chrome\//.test(normalized)) return "Safari";
  return undefined;
}

function inferOs(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const normalized = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(normalized)) return "iOS";
  if (/android/.test(normalized)) return "Android";
  if (/mac os x|macintosh/.test(normalized)) return "macOS";
  if (/windows nt/.test(normalized)) return "Windows";
  if (/linux/.test(normalized)) return "Linux";
  return undefined;
}

function readRemoteAddressFromSource(source: unknown): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: {
      readonly remoteAddress?: string | null;
    };
  };

  return normalizeIpAddress(candidate.socket?.remoteAddress ?? candidate.remoteAddress);
}

/** The socket peer address. Forwarded-for headers are not trusted anywhere in the server. */
export function readRequestRemoteAddress(
  request: HttpServerRequest.HttpServerRequest,
): string | undefined {
  return readRemoteAddressFromSource(request.source);
}

function normalizeAuthority(authority: string | undefined, protocol: string): string | undefined {
  const value = authority?.split(",")[0]?.trim();
  if (!value) {
    return undefined;
  }
  try {
    return new URL(`${protocol}//${value}`).host;
  } catch {
    return undefined;
  }
}

/**
 * Whether a browser request may use this server's ambient session cookie.
 *
 * Cookies are scoped by host, not port, so a page on another local port (an
 * agent's dev server, say) is same-site and its WebSocket upgrades carry our
 * cookie. Requests without `Origin` come from non-browser clients. Otherwise
 * the Origin's host:port must be the authority the browser addressed: `Host`,
 * or `X-Forwarded-Host` from proxies that rewrite `Host` (Tailscale serve,
 * Vite). A page cannot forge `X-Forwarded-Host` on a cookie-bearing request:
 * WebSocket cannot set headers and a custom header forces a CORS preflight,
 * which never grants credentials to an unlisted origin.
 *
 * In dev, the credentialed CORS origins are accepted, as is any origin on the
 * Vite port (LAN and loopback aliases reach the server through Vite's proxy,
 * which rewrites `Host`).
 */
export function isTrustedRequestOrigin(
  request: HttpServerRequest.HttpServerRequest,
  options: {
    readonly allowedOrigins: ReadonlyArray<string>;
    readonly devUrl: URL | undefined;
  },
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  if (options.allowedOrigins.includes(origin)) {
    return true;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    // Includes the opaque `null` origin of sandboxed documents.
    return false;
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    return false;
  }
  if (options.devUrl?.port && originUrl.port === options.devUrl.port) {
    return true;
  }
  return [request.headers.host, request.headers["x-forwarded-host"]].some(
    (authority) => normalizeAuthority(authority, originUrl.protocol) === originUrl.host,
  );
}

export function deriveAuthClientMetadata(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presented?: AuthClientPresentationMetadata;
}): AuthClientMetadata {
  const userAgent = normalizeNonEmptyString(input.request.headers["user-agent"]);
  const ipAddress = readRemoteAddressFromSource(input.request.source);
  const os = input.presented?.os ?? inferOs(userAgent);
  const browser = inferBrowser(userAgent);
  return {
    ...(input.presented?.label ? { label: input.presented.label } : {}),
    ...(ipAddress ? { ipAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
    deviceType: input.presented?.deviceType ?? inferDeviceType(userAgent),
    ...(os ? { os } : {}),
    ...(browser ? { browser } : {}),
  };
}
