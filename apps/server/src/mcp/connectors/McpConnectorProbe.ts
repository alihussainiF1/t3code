/**
 * "Does it work" checks for MCP connectors: an MCP initialize handshake
 * followed by tools/list, over streamable HTTP or a spawned stdio process.
 *
 * The handshake is written against a two-method transport so it can be
 * driven by canned responses; the HTTP and stdio transports below are the
 * only parts that touch the network or spawn processes.
 *
 * @module McpConnectorProbe
 */
// @effect-diagnostics nodeBuiltinImport:off - the probe owns a short-lived child over raw stdio pipes.
// @effect-diagnostics globalTimers:off - plain async functions, driven by canned transports in tests.
import * as NodeChildProcess from "node:child_process";

import type { FetchLike } from "./McpOAuth.ts";

export type McpProbeOutcome =
  | { readonly status: "connected"; readonly toolCount: number }
  | { readonly status: "needs-auth"; readonly message?: string }
  | { readonly status: "error"; readonly message: string };

/** Thrown by a transport when the server refuses the credentials (HTTP 401/403). */
export class McpProbeAuthRequired extends Error {
  override readonly name = "McpProbeAuthRequired";
}

export interface McpProbeTransport {
  /** Sends a JSON-RPC request and resolves with its `result`; rejects on a JSON-RPC error. */
  readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  readonly notify: (method: string, params?: Record<string, unknown>) => Promise<void>;
  /** Releases the session or process. Never rejects. */
  readonly close: () => Promise<void>;
}

export const MCP_PROBE_PROTOCOL_VERSION = "2025-06-18";
const MAX_TOOL_PAGES = 20;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Runs initialize, notifications/initialized, and every tools/list page,
 * then closes the transport. A timeout or failure at any step becomes an
 * outcome; this never rejects.
 */
export async function probeMcpServer(
  transport: McpProbeTransport,
  options: { readonly timeoutMs: number },
): Promise<McpProbeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<McpProbeOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "error",
          message: `The server did not answer within ${Math.round(options.timeoutMs / 1000)} seconds.`,
        }),
      options.timeoutMs,
    );
  });
  const handshake = (async (): Promise<McpProbeOutcome> => {
    const initialized = asRecord(
      await transport.request("initialize", {
        protocolVersion: MCP_PROBE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "t3-code", version: "0.0.0" },
      }),
    );
    if (!initialized || typeof initialized.protocolVersion !== "string") {
      return { status: "error", message: "The server's initialize response was not MCP." };
    }
    await transport.notify("notifications/initialized");
    // A server without the tools capability has nothing to list.
    if (asRecord(initialized.capabilities)?.tools === undefined) {
      return { status: "connected", toolCount: 0 };
    }
    let toolCount = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const listed = asRecord(await transport.request("tools/list", cursor ? { cursor } : {}));
      const tools = listed?.tools;
      if (!Array.isArray(tools)) {
        return { status: "error", message: "The server's tools/list response was not MCP." };
      }
      toolCount += tools.length;
      cursor =
        typeof listed?.nextCursor === "string" && listed.nextCursor ? listed.nextCursor : undefined;
      if (!cursor) break;
    }
    return { status: "connected", toolCount };
  })().catch((cause): McpProbeOutcome =>
    cause instanceof McpProbeAuthRequired
      ? { status: "needs-auth", message: cause.message }
      : { status: "error", message: describe(cause) },
  );
  try {
    return await Promise.race([handshake, timeout]);
  } finally {
    clearTimeout(timer);
    await transport.close();
  }
}

class JsonRpcError extends Error {
  override readonly name = "JsonRpcError";
}

function resultOf(message: Record<string, unknown>): unknown {
  const error = asRecord(message.error);
  if (error) {
    throw new JsonRpcError(
      typeof error.message === "string" && error.message
        ? error.message
        : "The server returned an error.",
    );
  }
  return message.result;
}

/** Reads `text/event-stream` until the JSON-RPC response with `id` arrives. */
async function readSseResponse(response: Response, id: number): Promise<Record<string, unknown>> {
  const body = response.body;
  if (!body) throw new Error("The server sent an empty event stream.");
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += value;
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (events.pop() ?? "");
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const message = asRecord(parsed);
        if (message && message.id === id) return message;
      }
      if (done) break;
    }
  } finally {
    // Streams may stay open for server notifications; stop reading once answered.
    void reader.cancel().catch(() => undefined);
  }
  throw new Error("The server closed the event stream without answering.");
}

/** Streamable HTTP transport for one probe. */
export function createHttpProbeTransport(
  fetchImpl: FetchLike,
  url: string,
  headers: Readonly<Record<string, string>>,
): McpProbeTransport {
  const abort = new AbortController();
  let sessionId: string | undefined;
  let nextId = 1;

  const post = async (body: Record<string, unknown>) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROBE_PROTOCOL_VERSION,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: abort.signal,
    });
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      throw new McpProbeAuthRequired(
        response.status === 401
          ? "The server needs you to sign in."
          : "The server refused the saved credentials.",
      );
    }
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return response;
  };

  return {
    request: async (method, params) => {
      const id = nextId++;
      const response = await post({ id, method, params });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error(
          response.status === 404 || response.status === 405
            ? `No MCP endpoint at this URL (HTTP ${response.status}). Servers that only speak the older SSE transport are not supported.`
            : `The server answered HTTP ${response.status}.`,
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return resultOf(await readSseResponse(response, id));
      }
      const message = asRecord(await response.json().catch(() => undefined));
      if (!message) throw new Error("The server's response was not JSON.");
      return resultOf(message);
    },
    notify: async (method, params) => {
      const response = await post({ method, ...(params ? { params } : {}) });
      void response.body?.cancel().catch(() => undefined);
    },
    close: async () => {
      if (sessionId) {
        await fetchImpl(url, {
          method: "DELETE",
          headers: { ...headers, "mcp-session-id": sessionId },
          signal: AbortSignal.timeout(2_000),
        }).catch(() => undefined);
      }
      abort.abort();
    },
  };
}

export interface StdioProbeCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Windows `.cmd` shims need a shell; the args are already escaped for it. */
  readonly shell: boolean;
  /** Start a process group (POSIX) so closing reaches what npx/uvx spawned. */
  readonly detached: boolean;
  readonly cwd?: string;
}

const STDERR_TAIL_CHARS = 600;

/** Stdio transport for one probe: newline-delimited JSON-RPC over a child process it owns. */
export function createStdioProbeTransport(input: StdioProbeCommand): McpProbeTransport {
  const detached = input.detached;
  const child = NodeChildProcess.spawn(input.command, [...input.args], {
    env: input.env,
    shell: input.shell,
    detached,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(input.cwd ? { cwd: input.cwd } : {}),
  });
  const pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (cause: unknown) => void }
  >();
  let stderr = "";
  let stdout = "";
  let exited: Error | undefined;
  let nextId = 1;

  const failAll = (cause: Error) => {
    exited ??= cause;
    for (const entry of pending.values()) entry.reject(cause);
    pending.clear();
  };
  const exitError = (detail: string) => {
    const tail = stderr.trim().slice(-STDERR_TAIL_CHARS);
    return new Error(tail ? `${detail}: ${tail}` : `${detail}.`);
  };

  child.on("error", (cause: NodeJS.ErrnoException) =>
    failAll(
      new Error(
        cause.code === "ENOENT"
          ? `"${input.command}" was not found on this environment's PATH.`
          : cause.message,
      ),
    ),
  );
  child.on("exit", (code, signal) =>
    failAll(exitError(`The server exited (${signal ?? `code ${code ?? "unknown"}`})`)),
  );
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS * 4);
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      let message: Record<string, unknown> | undefined;
      try {
        message = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (!message) continue;
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        try {
          entry.resolve(resultOf(message));
        } catch (cause) {
          entry.reject(cause);
        }
      } else if (message.id !== undefined && typeof message.method === "string") {
        // A server-initiated request (roots, sampling): decline so the server is not left waiting.
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Not supported during a connection check." },
        });
      }
    }
  });

  function write(message: Record<string, unknown>) {
    if (exited || !child.stdin?.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (exited) {
          reject(exited);
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        write({ jsonrpc: "2.0", id, method, params });
      }),
    notify: async (method, params) => {
      write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    },
    close: async () => {
      failAll(new Error("Closed."));
      child.stdin?.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Launchers like npx and uvx run the server as their own child, so the
      // whole process group this probe created at spawn is signalled.
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // Fall through to the direct child.
        }
      }
      child.kill();
    },
  };
}
