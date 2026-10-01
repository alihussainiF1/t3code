import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ResolvedMcpConnector } from "./connectors/McpConnectorTranslators.ts";
import type { SessionSkills } from "../skills/SkillDelivery.ts";

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
  skillsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
  connectorsByThread.clear();
  skillsByThread.clear();
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
 * Library skills resolved for the thread's next provider session, with their
 * delivery root built. Adapters read this at session start (and ACP adapters
 * on each prompt) to hand the skills over natively or as an index.
 */
const skillsByThread = new Map<ThreadId, SessionSkills>();

export function setSessionSkills(threadId: ThreadId, skills: SessionSkills | undefined): void {
  if (skills === undefined) skillsByThread.delete(threadId);
  else skillsByThread.set(threadId, skills);
}

export function readSessionSkills(threadId: ThreadId): SessionSkills | undefined {
  return skillsByThread.get(threadId);
}
