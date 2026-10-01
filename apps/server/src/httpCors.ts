export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
] as const;

const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];

/**
 * Origins that may make credentialed (cookie) requests in dev: the Vite page,
 * the Electron renderer, and `T3CODE_DEV_ALLOWED_ORIGINS`. Empty outside dev.
 */
export function devCredentialedOrigins(config: {
  readonly devUrl: URL | undefined;
  readonly devAllowedOrigins: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  return config.devUrl
    ? [config.devUrl.origin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins]
    : [];
}
