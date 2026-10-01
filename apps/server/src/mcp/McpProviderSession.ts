import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ResolvedMcpConnector } from "./connectors/McpConnectorTranslators.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
  connectorsByThread.delete(threadId);
  exclusiveThreads.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
  connectorsByThread.clear();
  exclusiveThreads.clear();
}

/**
 * User-configured MCP connectors resolved for the thread's next provider
 * session, with secrets materialized. Set independently of the `t3-code`
 * credential: connectors still attach when agent browser/device access is off.
 */
const connectorsByThread = new Map<ThreadId, ReadonlyArray<ResolvedMcpConnector>>();

export function setMcpConnectors(
  threadId: ThreadId,
  connectors: ReadonlyArray<ResolvedMcpConnector>,
): void {
  if (connectors.length === 0) connectorsByThread.delete(threadId);
  else connectorsByThread.set(threadId, connectors);
}

export function readMcpConnectors(threadId: ThreadId): ReadonlyArray<ResolvedMcpConnector> {
  return connectorsByThread.get(threadId) ?? [];
}

/**
 * Threads whose provider must load only T3's MCP servers, ignoring the ones
 * in its own config. ProviderService sets this for every session from the
 * `mcpConnectorsLoadProviderConfigs` setting (off by default, so exclusive);
 * sessions started any other way keep the provider's own behavior.
 */
const exclusiveThreads = new Set<ThreadId>();

export function setMcpExclusive(threadId: ThreadId, exclusive: boolean): void {
  if (exclusive) exclusiveThreads.add(threadId);
  else exclusiveThreads.delete(threadId);
}

export function readMcpExclusive(threadId: ThreadId): boolean {
  return exclusiveThreads.has(threadId);
}
