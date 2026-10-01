/**
 * Decides whether the default-home server described by a parsed
 * `server-runtime.json` may be reused by an SSH launch, returning its pid and
 * port when it may. Only a server bound to loopback qualifies: the SSH tunnel
 * is the access path, so a server the user started on all interfaces is never
 * silently adopted. `host` is the recorded bind host; runtime files from
 * servers that predate it fall back to the loopback `origin` check alone.
 *
 * The remote launch script embeds this function's source in a Node snippet,
 * and the archive runtime's `__ssh-helper runtime-port` calls it directly, so
 * it must stay self-contained: no imports, no closures over module scope.
 */
export function resolveReusableRuntimeServer(
  runtime: unknown,
): { readonly pid: number; readonly port: number } | null {
  if (typeof runtime !== "object" || runtime === null) {
    return null;
  }
  const record = runtime as { pid?: unknown; port?: unknown; origin?: unknown; host?: unknown };
  const pid = Number(record.pid);
  const port = Number(record.port);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {
    return null;
  }
  let origin: URL;
  try {
    origin = new URL(String(record.origin ?? ""));
  } catch {
    return null;
  }
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    return null;
  }
  if (record.host !== undefined) {
    if (typeof record.host !== "string") {
      return null;
    }
    const host = record.host.trim().toLowerCase();
    const loopback =
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
    if (!loopback) {
      return null;
    }
  }
  return { pid, port };
}
