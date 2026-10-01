import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { MCP_CONNECTOR_OAUTH_CALLBACK_PATH, McpConnectorService } from "./McpConnectorService.ts";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );

function page(title: string, message: string, status: number) {
  return HttpServerResponse.text(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>` +
      `<style>body{font:15px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color-scheme:light dark}</style></head>` +
      `<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
    {
      status,
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    },
  );
}

/**
 * The authorization server's redirect target. Unauthenticated by design: the
 * browser arriving here may not carry a T3 session (hosted web, another
 * device), and the one-time `state` plus the server-held PKCE verifier are
 * what bind the code to the flow the user started.
 */
export const mcpConnectorOAuthRouteLayer = HttpRouter.add(
  "GET",
  MCP_CONNECTOR_OAUTH_CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return page("Sign-in failed", "The request was malformed.", 400);
    const params = url.value.searchParams;
    const state = params.get("state");
    if (!state) return page("Sign-in failed", "The request was missing its state.", 400);
    const code = params.get("code");
    const error = params.get("error");
    const errorDescription = params.get("error_description");
    const connectors = yield* McpConnectorService;
    return yield* connectors
      .completeOAuth({
        state,
        ...(code ? { code } : {}),
        ...(error ? { error } : {}),
        ...(errorDescription ? { errorDescription } : {}),
      })
      .pipe(
        Effect.map((name) =>
          page(
            `Connected ${name}`,
            "You can close this window and return to T3 Code. New threads get this connector's tools.",
            200,
          ),
        ),
        Effect.catch((failure) =>
          Effect.logWarning("MCP connector sign-in failed", {
            connectorId: failure.connectorId,
            detail: failure.detail,
          }).pipe(Effect.as(page("Sign-in failed", failure.detail, 400))),
        ),
      );
  }),
);
