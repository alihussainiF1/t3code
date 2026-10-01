import { describe, expect, it } from "vite-plus/test";

import {
  createHttpProbeTransport,
  McpProbeAuthRequired,
  type McpProbeTransport,
  probeMcpServer,
} from "./McpConnectorProbe.ts";
import type { FetchLike } from "./McpOAuth.ts";

/** A transport answering from a method → result table; functions may throw. */
function scripted(
  answers: Record<string, (params: Record<string, unknown>) => unknown>,
): McpProbeTransport & { readonly calls: string[]; closed: boolean } {
  const calls: string[] = [];
  const transport = {
    calls,
    closed: false,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push(method);
      const answer = answers[method];
      if (!answer) throw new Error(`Method not found: ${method}`);
      return answer(params);
    },
    notify: async (method: string) => {
      calls.push(method);
    },
    close: async () => {
      transport.closed = true;
    },
  };
  return transport;
}

const initialized =
  (capabilities: Record<string, unknown> = { tools: {} }) =>
  () => ({
    protocolVersion: "2025-06-18",
    capabilities,
    serverInfo: { name: "test", version: "1" },
  });

describe("probeMcpServer", () => {
  it("counts tools across pages after the initialize handshake", async () => {
    const transport = scripted({
      initialize: initialized(),
      "tools/list": (params) =>
        params.cursor === "page-2"
          ? { tools: [{ name: "c" }] }
          : { tools: [{ name: "a" }, { name: "b" }], nextCursor: "page-2" },
    });
    expect(await probeMcpServer(transport, { timeoutMs: 1_000 })).toEqual({
      status: "connected",
      toolCount: 3,
    });
    expect(transport.calls).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
    ]);
    expect(transport.closed).toBe(true);
  });

  it("reports zero tools without listing when the server has no tools capability", async () => {
    const transport = scripted({ initialize: initialized({ prompts: {} }) });
    expect(await probeMcpServer(transport, { timeoutMs: 1_000 })).toEqual({
      status: "connected",
      toolCount: 0,
    });
    expect(transport.calls).not.toContain("tools/list");
  });

  it("reports needs-auth when the server refuses the credentials", async () => {
    const transport = scripted({
      initialize: () => {
        throw new McpProbeAuthRequired("The server needs you to sign in.");
      },
    });
    expect(await probeMcpServer(transport, { timeoutMs: 1_000 })).toEqual({
      status: "needs-auth",
      message: "The server needs you to sign in.",
    });
    expect(transport.closed).toBe(true);
  });

  it("reports errors and non-MCP answers", async () => {
    expect(
      await probeMcpServer(scripted({ initialize: () => ({ hello: "world" }) }), {
        timeoutMs: 1_000,
      }),
    ).toEqual({ status: "error", message: "The server's initialize response was not MCP." });
    expect(
      await probeMcpServer(
        scripted({
          initialize: initialized(),
          "tools/list": () => {
            throw new Error("boom");
          },
        }),
        { timeoutMs: 1_000 },
      ),
    ).toEqual({ status: "error", message: "boom" });
  });

  it("gives up and closes when the server never answers", async () => {
    const transport = {
      closed: false,
      request: () => new Promise<never>(() => undefined),
      notify: async () => undefined,
      close: async () => {
        transport.closed = true;
      },
    };
    const outcome = await probeMcpServer(transport, { timeoutMs: 10 });
    expect(outcome.status).toBe("error");
    expect(transport.closed).toBe(true);
  });
});

describe("createHttpProbeTransport", () => {
  it("speaks streamable HTTP: session ids, SSE answers, and a closing DELETE", async () => {
    const seen: Array<{ method: string; session: string | null; auth: string | null }> = [];
    const fetch: FetchLike = async (_url, init) => {
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      seen.push({
        method,
        session: headers.get("mcp-session-id"),
        auth: headers.get("authorization"),
      });
      if (method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: initialized()() }),
          { headers: { "content-type": "application/json", "mcp-session-id": "s-1" } },
        );
      }
      // tools/list answers over SSE after an unrelated notification.
      const stream =
        `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n` +
        `event: message\ndata: {"jsonrpc":"2.0","id":${body.id},"result":{"tools":[{"name":"x"},{"name":"y"}]}}\n\n`;
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    };
    const outcome = await probeMcpServer(
      createHttpProbeTransport(fetch, "https://mcp.example.com/mcp", { Authorization: "Bearer t" }),
      { timeoutMs: 1_000 },
    );
    expect(outcome).toEqual({ status: "connected", toolCount: 2 });
    expect(seen.map(({ method, session }) => [method, session])).toEqual([
      ["POST", null],
      ["POST", "s-1"],
      ["POST", "s-1"],
      ["DELETE", "s-1"],
    ]);
    expect(seen.every(({ auth }) => auth === "Bearer t")).toBe(true);
  });

  it("maps 401 to needs-auth and 405 to a clear error", async () => {
    const status =
      (code: number): FetchLike =>
      async () =>
        new Response(null, { status: code });
    expect(
      await probeMcpServer(createHttpProbeTransport(status(401), "https://x.test/mcp", {}), {
        timeoutMs: 1_000,
      }),
    ).toMatchObject({ status: "needs-auth" });
    const notMcp = await probeMcpServer(
      createHttpProbeTransport(status(405), "https://x.test/", {}),
      { timeoutMs: 1_000 },
    );
    expect(notMcp.status).toBe("error");
    expect(notMcp.status === "error" ? notMcp.message : "").toContain("No MCP endpoint");
  });
});
