/**
 * Connectors settings - MCP servers configured once per environment and
 * attached to every provider session there. Definitions live in that
 * environment's settings; secrets and OAuth tokens stay in its secret store.
 *
 * @module ConnectorsSettings
 */
import type {
  DiscoveredMcpServer,
  EnvironmentId,
  McpConnectorCheck,
  McpConnectorConfig,
  McpConnectorId,
} from "@t3tools/contracts";
import { InfoIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { type EnvironmentPresentation, useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ConnectorCatalogSection } from "./ConnectorCatalog";
import { ConnectorDialog } from "./ConnectorDialog";
import {
  connectorCheckLabel,
  connectorProvidersSummary,
  connectorStatus,
  connectorTransportSummary,
  DISCOVERY_SOURCE_LABELS,
  discoveredServerImportState,
  groupDiscoveredServers,
  importableDiscoveredServers,
} from "./ConnectorsSettings.logic";
import {
  type ProviderOperateAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { getDriverOption } from "./providerDriverMeta";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

const EMPTY_DISCOVERED: ReadonlyArray<DiscoveredMcpServer> = [];

/** Connectors are machine state, so the page shows the one environment the scope selector picked. */
export function ConnectorsSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  // A project scope lets discovery read that project's `.mcp.json` and
  // Claude project entries on the selected environment.
  const cwd =
    environment && (scope.kind === "project" || scope.kind === "checkout")
      ? (scope.members.find((member) => member.environmentId === environment.environmentId)
          ?.workspaceRoot ?? null)
      : null;
  return (
    <SettingsPageContainer>
      {environment === null ? (
        <SettingsSection title="Connectors">
          <SettingsRow
            title={
              scope.kind === "environment"
                ? `Reconnect ${scope.label} to manage its connectors.`
                : "Connect an environment to manage its connectors."
            }
          />
        </SettingsSection>
      ) : environment.serverConfig?.environment.capabilities.mcpConnectors !== true ? (
        <SettingsSection title="Connectors">
          <SettingsRow
            title={`Update the server on ${environment.label} to use connectors.`}
            description="Connectors need a newer T3 Code server."
          />
        </SettingsSection>
      ) : (
        <AccessGatedConnectors
          key={environment.environmentId}
          environment={environment}
          cwd={cwd}
        />
      )}
    </SettingsPageContainer>
  );
}

function AccessGatedConnectors({
  environment,
  cwd,
}: {
  readonly environment: EnvironmentPresentation;
  readonly cwd: string | null;
}) {
  if (environment.entry.target._tag !== "PrimaryConnectionTarget") {
    return <RemoteSessionConnectors environment={environment} cwd={cwd} />;
  }
  // The desktop app owns its primary server outright; a browser session
  // checks the scopes its cookie session was granted.
  return isElectron ? (
    <EnvironmentConnectors environment={environment} cwd={cwd} access="granted" />
  ) : (
    <PrimarySessionConnectors environment={environment} cwd={cwd} />
  );
}

function PrimarySessionConnectors(props: {
  readonly environment: EnvironmentPresentation;
  readonly cwd: string | null;
}) {
  const session = usePrimarySessionState();
  const access = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: session.data,
    isPending: session.isPending,
    hasError: session.error !== null,
  });
  return <EnvironmentConnectors {...props} access={access} />;
}

function RemoteSessionConnectors(props: {
  readonly environment: EnvironmentPresentation;
  readonly cwd: string | null;
}) {
  const session = useEnvironmentSessionState(props.environment.environmentId);
  const access = resolveRemoteOperateAccess({
    session: session.data,
    isPending: session.isPending,
    hasError: session.hasError,
  });
  return <EnvironmentConnectors {...props} access={access} />;
}

function EnvironmentConnectors({
  environment,
  cwd,
  access,
}: {
  readonly environment: EnvironmentPresentation;
  readonly cwd: string | null;
  readonly access: ProviderOperateAccess;
}) {
  const environmentId = environment.environmentId;
  // Pending access renders read-only until the session answers, so a
  // write is never offered and then refused.
  const readOnly = access !== "granted";
  const connectors = useEnvironmentSettings(environmentId, (settings) => settings.mcpConnectors);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [dialog, setDialog] = useState<
    { readonly id: McpConnectorId; readonly config: McpConnectorConfig } | "new" | null
  >(null);
  const entries = Object.entries(connectors) as Array<[McpConnectorId, McpConnectorConfig]>;

  const installConnector = useAtomCommand(serverEnvironment.installMcpConnector, {
    label: "add connector",
  });
  const saveConnector = (id: McpConnectorId | null, config: McpConnectorConfig) => {
    if (id === null) {
      // New connectors are added and checked by the server in one step.
      void installConnector({ environmentId, input: { config } }).then((result) => {
        if (result._tag === "Success" && result.value.check.status === "error") {
          toastManager.add({
            type: "error",
            title: `${config.name} was added but is not working yet`,
            description: result.value.check.message ?? "Use Test to check it again.",
          });
        }
      });
      return;
    }
    // The patch names only this entry; the server merges it into its map.
    updateSettings({ mcpConnectors: { [id]: config } });
  };

  return (
    <>
      <ProviderConfigsBanner environmentId={environmentId} cwd={cwd} readOnly={readOnly} />
      <ConnectorCatalogSection
        environmentId={environmentId}
        environmentLabel={environment.label}
        connectors={connectors}
        readOnly={readOnly}
      />
      <SettingsSection
        {...searchableSetting("mcp-connectors")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setDialog("new")}>
              <PlusIcon className="size-3" aria-hidden />
              Add connector
            </Button>
          ) : null
        }
      >
        {readOnly && access === "denied" ? (
          <SettingsRow
            title="View only"
            description={`This session can view ${environment.label}'s connectors but can't change them.`}
          />
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow
            title="No connectors yet."
            description="Add an MCP server once and every provider session on this environment gets it. Threads can turn connectors off individually."
          />
        ) : (
          entries.map(([id, config]) => (
            <ConnectorRow
              key={id}
              environmentId={environmentId}
              id={id}
              config={config}
              readOnly={readOnly}
              onToggle={(enabled) =>
                updateSettings({ mcpConnectors: { [id]: { ...config, enabled } } })
              }
              onEdit={() => setDialog({ id, config })}
              onDelete={() => updateSettings({ mcpConnectors: { [id]: null } })}
            />
          ))
        )}
      </SettingsSection>
      <ImportConnectorsSection environmentId={environmentId} cwd={cwd} readOnly={readOnly} />
      {dialog !== null && !readOnly ? (
        <ConnectorDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          editing={dialog === "new" ? null : dialog}
          environmentLabel={environment.label}
          onSave={(config) => saveConnector(dialog === "new" ? null : dialog.id, config)}
        />
      ) : null}
    </>
  );
}

function ConnectorRow({
  environmentId,
  id,
  config,
  readOnly,
  onToggle,
  onEdit,
  onDelete,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: McpConnectorId;
  readonly config: McpConnectorConfig;
  readonly readOnly: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const status = connectorStatus(config);
  const providers = connectorProvidersSummary(
    config.providers,
    (driver) => getDriverOption(driver)?.label ?? driver,
  );
  return (
    <SettingsRow
      title={config.name}
      description={
        <span className="break-all">
          {config.transport.type === "stdio" ? "Local · " : "Remote · "}
          {connectorTransportSummary(config)}
          {providers ? ` · ${providers}` : ""}
        </span>
      }
      status={
        <span className="flex flex-wrap items-center gap-2">
          {config.enabled ? <CheckBadge check={config.lastCheck} /> : null}
          {status.kind === "ready" ? null : status.kind === "missing-token" ? (
            <Badge variant="warning">Missing token</Badge>
          ) : (
            <OAuthStatus
              environmentId={environmentId}
              id={id}
              connectedAt={status.kind === "oauth-connected" ? status.connectedAt : null}
              readOnly={readOnly}
            />
          )}
        </span>
      }
      control={
        <>
          {!readOnly ? (
            <>
              <TestConnectorButton environmentId={environmentId} id={id} />
              <Button size="xs" variant="ghost" onClick={onEdit}>
                Edit
              </Button>
              <DeleteConnectorButton name={config.name} onConfirm={onDelete} />
            </>
          ) : null}
          <Switch
            aria-label={`Enable ${config.name}`}
            checked={config.enabled}
            disabled={readOnly}
            onCheckedChange={onToggle}
          />
        </>
      }
    />
  );
}

/**
 * Connection state comes from settings (`connectedAt`), which the server
 * updates when its OAuth callback completes, so this only starts the flow.
 */
function OAuthStatus({
  environmentId,
  id,
  connectedAt,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: McpConnectorId;
  readonly connectedAt: string | null;
  readonly readOnly: boolean;
}) {
  useRelativeTimeTick(60_000);
  // The server's address as this client reaches it, so the provider's
  // redirect lands back on it through tunnels and remote origins too.
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const startOAuth = useAtomCommand(serverEnvironment.startMcpConnectorOAuth, {
    label: "connect connector",
  });
  const disconnect = useAtomCommand(serverEnvironment.disconnectMcpConnectorOAuth, {
    label: "disconnect connector",
  });
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const openPage = async (url: string) => {
    try {
      await ensureLocalApi().shell.openExternal(url);
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not open the sign-in page",
        description: "Use Open sign-in page to try again.",
      });
    }
  };

  const connect = async () => {
    if (httpBaseUrl === null) {
      toastManager.add({
        type: "error",
        title: "Environment unavailable",
        description: "Reconnect this environment and try again.",
      });
      return;
    }
    setPending(true);
    try {
      const result = await startOAuth({
        environmentId,
        input: { connectorId: id, redirectBaseUrl: httpBaseUrl },
      });
      if (result._tag !== "Success") return;
      setAuthorizationUrl(result.value.authorizationUrl);
      await openPage(result.value.authorizationUrl);
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-2">
      {connectedAt ? (
        <Badge variant="success">Connected {formatRelativeTimeLabel(connectedAt)}</Badge>
      ) : (
        <Badge variant="warning">Not connected</Badge>
      )}
      {!readOnly ? (
        <>
          <Button size="xs" variant="outline" disabled={pending} onClick={() => void connect()}>
            {connectedAt ? "Reconnect" : "Connect"}
          </Button>
          {connectedAt ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => void disconnect({ environmentId, input: { connectorId: id } })}
            >
              Disconnect
            </Button>
          ) : null}
          {authorizationUrl && !connectedAt ? (
            <Button size="xs" variant="ghost" onClick={() => void openPage(authorizationUrl)}>
              Open sign-in page
            </Button>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

/** Deleting removes the connector's stored secrets and tokens too, so it asks first. */
function DeleteConnectorButton({
  name,
  onConfirm,
}: {
  readonly name: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Provider sessions stop receiving this server, and its saved secrets and sign-in are
              removed from this environment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Delete connector
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** The server's last "does it work" check, with its reason on hover. */
function CheckBadge({ check }: { readonly check: McpConnectorCheck | undefined }) {
  if (!check) return null;
  const badge = (
    <Badge variant={check.status === "connected" ? "success" : "warning"}>
      {connectorCheckLabel(check)}
    </Badge>
  );
  return check.message ? (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipPopup side="top">{check.message}</TooltipPopup>
    </Tooltip>
  ) : (
    badge
  );
}

function TestConnectorButton({
  environmentId,
  id,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: McpConnectorId;
}) {
  const test = useAtomCommand(serverEnvironment.testMcpConnector, { label: "check connector" });
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        setPending(true);
        void test({ environmentId, input: { connectorId: id } }).finally(() => setPending(false));
      }}
    >
      {pending ? "Testing…" : "Test"}
    </Button>
  );
}

/**
 * T3 hands agents only its own connectors, so servers still configured in a
 * provider CLI would silently stop loading. This offers to bring them over.
 */
function ProviderConfigsBanner({
  environmentId,
  cwd,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly readOnly: boolean;
}) {
  const loadProviderConfigs = useEnvironmentSettings(
    environmentId,
    (settings) => settings.mcpConnectorsLoadProviderConfigs,
  );
  const discovery = useEnvironmentQuery(
    serverEnvironment.discoverMcpConnectors({ environmentId, input: cwd ? { cwd } : {} }),
  );
  const importAll = useAtomCommand(serverEnvironment.importAllMcpConnectors, {
    label: "import MCP servers",
  });
  const [dismissed, setDismissed] = useState(false);
  const [importing, setImporting] = useState(false);
  const importable = useMemo(
    () => importableDiscoveredServers(discovery.data?.servers ?? EMPTY_DISCOVERED),
    [discovery.data],
  );
  if (readOnly || dismissed || loadProviderConfigs || importable.length === 0) return null;
  const sources = [
    ...new Set(importable.map((server) => DISCOVERY_SOURCE_LABELS[server.source].split(" (")[0])),
  ];
  const count = importable.length;
  return (
    <Alert variant="info">
      <InfoIcon />
      <AlertTitle>
        We found {count} MCP {count === 1 ? "server" : "servers"} in your {sources.join(" and ")}{" "}
        config
      </AlertTitle>
      <AlertDescription>
        Agents in T3 Code use only the connectors on this page. Import them to keep using them;
        secrets move into this environment's secret store.
      </AlertDescription>
      <AlertAction>
        <Button size="xs" variant="ghost" onClick={() => setDismissed(true)}>
          Not now
        </Button>
        <Button
          size="xs"
          disabled={importing}
          onClick={() => {
            setImporting(true);
            void importAll({ environmentId, input: cwd ? { cwd } : {} })
              .then((result) => {
                if (result._tag !== "Success") return;
                discovery.refresh();
                const { imported, skipped } = result.value;
                toastManager.add({
                  type: skipped.length > 0 ? "warning" : "success",
                  title: `Imported ${imported.length} ${imported.length === 1 ? "server" : "servers"}`,
                  description:
                    skipped.length > 0
                      ? `Not imported: ${skipped.map(({ name, reason }) => `${name} (${reason})`).join("; ")}`
                      : "Each one is being checked now.",
                });
              })
              .finally(() => setImporting(false));
          }}
        >
          {importing ? "Importing…" : "Import all"}
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** MCP servers already configured in the provider CLIs on this environment, ready to adopt. */
function ImportConnectorsSection({
  environmentId,
  cwd,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly readOnly: boolean;
}) {
  const discovery = useEnvironmentQuery(
    serverEnvironment.discoverMcpConnectors({
      environmentId,
      input: cwd ? { cwd } : {},
    }),
  );
  const importConnector = useAtomCommand(serverEnvironment.importMcpConnector, {
    label: "import connector",
  });
  const loadProviderConfigs = useEnvironmentSettings(
    environmentId,
    (settings) => settings.mcpConnectorsLoadProviderConfigs,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [importing, setImporting] = useState<string | null>(null);
  const groups = useMemo(
    () => groupDiscoveredServers(discovery.data?.servers ?? EMPTY_DISCOVERED),
    [discovery.data],
  );

  const runImport = async (server: DiscoveredMcpServer) => {
    const key = `${server.source}:${server.name}`;
    setImporting(key);
    try {
      const result = await importConnector({
        environmentId,
        input: { source: server.source, name: server.name, ...(cwd ? { cwd } : {}) },
      });
      if (result._tag === "Success") discovery.refresh();
    } finally {
      setImporting(null);
    }
  };

  return (
    <SettingsSection
      {...searchableSetting("mcp-connectors-import")}
      headerAction={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                onClick={discovery.refresh}
                disabled={discovery.isPending}
                aria-label="Rescan MCP servers"
              >
                <RefreshIcon refreshing={discovery.isPending} />
              </Button>
            }
          />
          <TooltipPopup side="top">Rescan provider configs</TooltipPopup>
        </Tooltip>
      }
    >
      <SettingsRow
        title="Also load MCP servers from each agent's own config"
        description="Off: agents get only the connectors above. On: Codex, Claude, and OpenCode also load the servers listed here from their own configs. New sessions follow the change."
        control={
          <Switch
            aria-label="Also load MCP servers from each agent's own config"
            checked={loadProviderConfigs}
            disabled={readOnly}
            onCheckedChange={(checked) =>
              updateSettings({ mcpConnectorsLoadProviderConfigs: checked })
            }
          />
        }
      />
      {discovery.error ? (
        <SettingsRow title="Could not scan for MCP servers." description={discovery.error} />
      ) : groups.length === 0 ? (
        <SettingsRow
          title={discovery.isPending ? "Scanning…" : "No MCP servers found."}
          description="Looks in Codex's config.toml, Claude Code's settings, and the project's .mcp.json."
        />
      ) : (
        groups.flatMap((group) =>
          group.servers.map((server) => {
            const state = discoveredServerImportState(server);
            const key = `${server.source}:${server.name}`;
            return (
              <SettingsRow
                key={key}
                title={server.name}
                description={
                  <span className="break-all">
                    {group.label} · {server.path}
                  </span>
                }
                status={server.note ?? null}
                control={
                  readOnly ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={state !== "importable" || importing !== null}
                      onClick={() => void runImport(server)}
                    >
                      {state === "imported"
                        ? "Imported"
                        : importing === key
                          ? "Importing…"
                          : "Import"}
                    </Button>
                  )
                }
              />
            );
          }),
        )
      )}
    </SettingsSection>
  );
}
