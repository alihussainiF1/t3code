/**
 * The connector gallery: built-in MCP servers and MCP Registry results as
 * tiles. One click adds the connector on the environment, which checks it;
 * remote servers that need sign-in go straight to their OAuth page, and
 * only token-based or parameterized entries ask for anything.
 *
 * @module ConnectorCatalog
 */
import {
  applyMcpCatalogFields,
  BUILT_IN_MCP_CATALOG,
  type EnvironmentId,
  type McpCatalogEntry,
  type McpConnectorConfig,
  type McpConnectorId,
} from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { ExternalLinkIcon, SearchIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type CatalogTileState,
  catalogTileState,
  connectorCheckLabel,
  filterCatalog,
  registryEntriesToShow,
  RUNTIME_FIXES,
} from "./ConnectorsSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const EMPTY_ENTRIES: ReadonlyArray<McpCatalogEntry> = [];
const BUILT_IN_ICON_DOMAINS = [
  ...new Set(BUILT_IN_MCP_CATALOG.flatMap((entry) => (entry.iconDomain ? [entry.iconDomain] : []))),
];

async function openPage(url: string) {
  try {
    await ensureLocalApi().shell.openExternal(url);
  } catch {
    toastManager.add({ type: "error", title: "Could not open the page", description: url });
  }
}

/**
 * Adding and signing in, shared by every tile. Sign-in pages may be blocked
 * as pop-ups after the add round trip, so their URLs stay available to the
 * tile as an explicit "Open sign-in page" button.
 */
function useConnectFlow(environmentId: EnvironmentId) {
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const install = useAtomCommand(serverEnvironment.installMcpConnector, {
    label: "add connector",
  });
  const startOAuth = useAtomCommand(serverEnvironment.startMcpConnectorOAuth, {
    label: "connect connector",
  });
  const test = useAtomCommand(serverEnvironment.testMcpConnector, { label: "check connector" });
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [signInUrls, setSignInUrls] = useState<Readonly<Record<string, string>>>({});
  const track = async <A,>(key: string, run: () => Promise<A>) => {
    setBusy((current) => new Set(current).add(key));
    try {
      return await run();
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const signIn = (connectorId: McpConnectorId) =>
    track(connectorId, async () => {
      if (httpBaseUrl === null) {
        toastManager.add({
          type: "error",
          title: "Environment unavailable",
          description: "Reconnect this environment and try again.",
        });
        return;
      }
      const result = await startOAuth({
        environmentId,
        input: { connectorId, redirectBaseUrl: httpBaseUrl },
      });
      if (result._tag !== "Success") return;
      setSignInUrls((current) => ({ ...current, [connectorId]: result.value.authorizationUrl }));
      await openPage(result.value.authorizationUrl);
    });

  const connect = (entry: McpCatalogEntry, config: McpConnectorConfig) =>
    track(entry.id, async () => {
      const result = await install({ environmentId, input: { config } });
      if (result._tag !== "Success") return;
      const { connectorId, check } = result.value;
      if (check.status === "connected") {
        toastManager.add({
          type: "success",
          title: `${entry.name} connected`,
          description: `${connectorCheckLabel(check)}. New threads can use it.`,
        });
        return;
      }
      const needsBrowserSignIn =
        check.status === "needs-auth" &&
        config.transport.type === "http" &&
        config.transport.auth.type !== "bearer" &&
        config.transport.headers.length === 0;
      if (needsBrowserSignIn) {
        await signIn(connectorId);
        return;
      }
      toastManager.add({
        type: "error",
        title: `${entry.name} was added but is not working yet`,
        description: check.message ?? "Use Test to check it again.",
      });
    });

  const retest = (connectorId: McpConnectorId) =>
    track(connectorId, () => test({ environmentId, input: { connectorId } }));

  return { busy, signInUrls, connect, signIn, retest };
}

export function ConnectorCatalogSection({
  environmentId,
  environmentLabel,
  connectors,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connectors: Readonly<Record<string, McpConnectorConfig>>;
  readonly readOnly: boolean;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query.trim(), { wait: 350 });
  const flow = useConnectFlow(environmentId);
  const [fieldsFor, setFieldsFor] = useState<McpCatalogEntry | null>(null);
  const [missingRuntime, setMissingRuntime] = useState<McpCatalogEntry | null>(null);
  const runtimes = useEnvironmentQuery(
    serverEnvironment.mcpConnectorRuntimes({ environmentId, input: {} }),
  );
  const registry = useEnvironmentQuery(
    debouncedQuery.length >= 2
      ? serverEnvironment.searchMcpRegistry({ environmentId, input: { query: debouncedQuery } })
      : null,
  );
  const builtIns = useMemo(() => filterCatalog(BUILT_IN_MCP_CATALOG, query), [query]);
  const registryEntries = useMemo(
    () => registryEntriesToShow(registry.data?.entries ?? EMPTY_ENTRIES, BUILT_IN_MCP_CATALOG),
    [registry.data],
  );
  const builtInIcons = useEnvironmentQuery(
    serverEnvironment.mcpConnectorIcons({
      environmentId,
      input: { domains: BUILT_IN_ICON_DOMAINS },
    }),
  );
  const registryDomains = useMemo(
    () => [
      ...new Set(registryEntries.flatMap((entry) => (entry.iconDomain ? [entry.iconDomain] : []))),
    ],
    [registryEntries],
  );
  const registryIcons = useEnvironmentQuery(
    registryDomains.length > 0
      ? serverEnvironment.mcpConnectorIcons({
          environmentId,
          input: { domains: registryDomains.slice(0, 64) },
        })
      : null,
  );
  const icons = useMemo(
    () => ({ ...builtInIcons.data?.icons, ...registryIcons.data?.icons }),
    [builtInIcons.data, registryIcons.data],
  );

  const onConnect = (entry: McpCatalogEntry) => {
    if (entry.runtime && runtimes.data && runtimes.data[entry.runtime] === false) {
      setMissingRuntime(entry);
      return;
    }
    if (entry.fields.length > 0) {
      setFieldsFor(entry);
      return;
    }
    void flow.connect(entry, entry.connector);
  };

  const renderTiles = (entries: ReadonlyArray<McpCatalogEntry>) => (
    <div className="grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-2 sm:px-4 xl:grid-cols-3">
      {entries.map((entry) => {
        const state = catalogTileState(entry, connectors);
        const busyKey = state.kind === "added" ? state.id : entry.id;
        return (
          <CatalogTile
            key={entry.id}
            entry={entry}
            icon={entry.iconDomain ? (icons[entry.iconDomain] ?? null) : null}
            state={state}
            busy={flow.busy.has(busyKey) || flow.busy.has(entry.id)}
            signInUrl={state.kind === "added" ? flow.signInUrls[state.id] : undefined}
            readOnly={readOnly}
            onConnect={onConnect}
            onSignIn={flow.signIn}
            onRetest={flow.retest}
          />
        );
      })}
    </div>
  );

  return (
    <>
      <SettingsSection
        {...searchableSetting("mcp-connectors-catalog")}
        headerAction={
          <InputGroup className="w-44 sm:w-56">
            <InputGroupAddon>
              <SearchIcon aria-hidden className="size-3" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              size="sm"
              placeholder="Search connectors"
              aria-label="Search connectors"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
              }}
            />
          </InputGroup>
        }
      >
        {builtIns.length > 0 ? (
          renderTiles(builtIns)
        ) : (
          <SettingsRow
            title={`No built-in connector matches "${query.trim()}".`}
            description="Community servers from the MCP Registry are listed below."
          />
        )}
      </SettingsSection>
      {query.trim().length >= 2 ? (
        <SettingsSection title="From the MCP Registry">
          {registry.error ? (
            <SettingsRow title="Could not search the MCP Registry." description={registry.error} />
          ) : registryEntries.length === 0 ? (
            <SettingsRow
              title={
                registry.isPending || debouncedQuery !== query.trim() ? "Searching…" : "No matches."
              }
              description="Community-published servers, not reviewed by T3 Code. Check a server's source before adding it."
            />
          ) : (
            <>
              <SettingsRow
                title="Community servers"
                description="Published to the official MCP Registry and not reviewed by T3 Code. Check a server's source before adding it."
              />
              {renderTiles(registryEntries)}
            </>
          )}
        </SettingsSection>
      ) : null}
      {fieldsFor ? (
        <CatalogFieldsDialog
          entry={fieldsFor}
          environmentLabel={environmentLabel}
          onClose={() => setFieldsFor(null)}
          onSubmit={(config) => {
            const entry = fieldsFor;
            setFieldsFor(null);
            void flow.connect(entry, config);
          }}
        />
      ) : null}
      {/* Disappears once a recheck finds the launcher; Connect then works. */}
      {missingRuntime?.runtime && runtimes.data?.[missingRuntime.runtime] !== true ? (
        <MissingRuntimeDialog
          entry={missingRuntime}
          runtime={missingRuntime.runtime}
          environmentLabel={environmentLabel}
          checking={runtimes.isPending}
          onRecheck={runtimes.refresh}
          onClose={() => setMissingRuntime(null)}
        />
      ) : null}
    </>
  );
}

function CatalogIcon({ icon, name }: { readonly icon: string | null; readonly name: string }) {
  return icon ? (
    <img src={icon} alt="" className="size-8 shrink-0 rounded-md" loading="lazy" decoding="async" />
  ) : (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-medium text-muted-foreground"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const CatalogTile = memo(function CatalogTile({
  entry,
  icon,
  state,
  busy,
  signInUrl,
  readOnly,
  onConnect,
  onSignIn,
  onRetest,
}: {
  readonly entry: McpCatalogEntry;
  readonly icon: string | null;
  readonly state: CatalogTileState;
  readonly busy: boolean;
  readonly signInUrl: string | undefined;
  readonly readOnly: boolean;
  readonly onConnect: (entry: McpCatalogEntry) => void;
  readonly onSignIn: (connectorId: McpConnectorId) => Promise<void>;
  readonly onRetest: (connectorId: McpConnectorId) => Promise<unknown>;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-lg border border-border/70 p-3">
      <CatalogIcon icon={icon} name={entry.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          {entry.source === "registry" ? (
            <Badge variant="outline" size="sm">
              Community
            </Badge>
          ) : null}
          {entry.runtime ? (
            <Badge variant="secondary" size="sm">
              Local
            </Badge>
          ) : null}
        </div>
        {entry.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <TileAction
            entry={entry}
            state={state}
            busy={busy}
            signInUrl={signInUrl}
            readOnly={readOnly}
            onConnect={onConnect}
            onSignIn={onSignIn}
            onRetest={onRetest}
          />
          {entry.docsUrl ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`${entry.name} documentation`}
              onClick={() => void openPage(entry.docsUrl!)}
            >
              <ExternalLinkIcon />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

function TileAction({
  entry,
  state,
  busy,
  signInUrl,
  readOnly,
  onConnect,
  onSignIn,
  onRetest,
}: {
  readonly entry: McpCatalogEntry;
  readonly state: CatalogTileState;
  readonly busy: boolean;
  readonly signInUrl: string | undefined;
  readonly readOnly: boolean;
  readonly onConnect: (entry: McpCatalogEntry) => void;
  readonly onSignIn: (connectorId: McpConnectorId) => Promise<void>;
  readonly onRetest: (connectorId: McpConnectorId) => Promise<unknown>;
}) {
  if (state.kind === "available") {
    return readOnly ? null : (
      <Button size="xs" variant="outline" disabled={busy} onClick={() => onConnect(entry)}>
        {busy ? (entry.runtime ? "Starting…" : "Connecting…") : "Connect"}
      </Button>
    );
  }
  if (busy) {
    return (
      <Badge variant="outline" size="sm">
        Checking…
      </Badge>
    );
  }
  if (state.check?.status === "connected") {
    return (
      <Badge variant="success" size="sm">
        {connectorCheckLabel(state.check)}
      </Badge>
    );
  }
  if (state.check?.status === "needs-auth" && state.usesOAuth) {
    return readOnly ? (
      <Badge variant="warning" size="sm">
        Needs sign-in
      </Badge>
    ) : (
      <>
        <Button size="xs" variant="outline" onClick={() => void onSignIn(state.id)}>
          Sign in
        </Button>
        {signInUrl ? (
          <Button size="xs" variant="ghost" onClick={() => void openPage(signInUrl)}>
            Open sign-in page
          </Button>
        ) : null}
      </>
    );
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge variant={state.check ? "warning" : "outline"} size="sm">
              {connectorCheckLabel(state.check)}
            </Badge>
          }
        />
        <TooltipPopup side="top">
          {state.check?.message ?? "Use Test to check whether it works."}
        </TooltipPopup>
      </Tooltip>
      {readOnly ? null : (
        <Button size="xs" variant="ghost" onClick={() => void onRetest(state.id)}>
          Test
        </Button>
      )}
    </>
  );
}

/** The one-field (or few-field) form for token-based and parameterized entries. */
function CatalogFieldsDialog({
  entry,
  environmentLabel,
  onClose,
  onSubmit,
}: {
  readonly entry: McpCatalogEntry;
  readonly environmentLabel: string;
  readonly onClose: () => void;
  readonly onSubmit: (config: McpConnectorConfig) => void;
}) {
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(entry.fields.map((field) => [field.id, field.defaultValue ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const result = applyMcpCatalogFields(entry, values);
    if (!result.ok) {
      setError(`Enter ${result.missing}.`);
      return;
    }
    onSubmit(result.config);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect {entry.name}</DialogTitle>
          <DialogDescription>
            Saved in {environmentLabel}'s secret store and shared with every provider there.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {entry.fields.map((field, index) => (
              <div key={field.id} className="grid gap-1.5">
                <Label htmlFor={`catalog-field-${field.id}`}>{field.label}</Label>
                <Input
                  id={`catalog-field-${field.id}`}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  placeholder={field.placeholder}
                  value={values[field.id] ?? ""}
                  autoFocus={index === 0}
                  onChange={(event) => {
                    const value = event.target.value;
                    setValues((current) => ({ ...current, [field.id]: value }));
                    setError(null);
                  }}
                />
                {field.description ? (
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                ) : null}
              </div>
            ))}
            {entry.tokenUrl ? (
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void openPage(entry.tokenUrl!)}
                >
                  <ExternalLinkIcon aria-hidden />
                  Create token
                </Button>
              </div>
            ) : null}
            {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit}>Connect</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MissingRuntimeDialog({
  entry,
  runtime,
  environmentLabel,
  checking,
  onRecheck,
  onClose,
}: {
  readonly entry: McpCatalogEntry;
  readonly runtime: "npx" | "uvx" | "docker";
  readonly environmentLabel: string;
  readonly checking: boolean;
  readonly onRecheck: () => void;
  readonly onClose: () => void;
}) {
  const fix = RUNTIME_FIXES[runtime];
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {entry.name} needs {fix.name}
          </DialogTitle>
          <DialogDescription>
            {entry.name} runs on {environmentLabel} through {runtime}, which is not on that
            machine's PATH.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm">{fix.how}</p>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => void openPage(fix.url)}>
            <ExternalLinkIcon aria-hidden />
            Get {fix.name}
          </Button>
          <Button disabled={checking} onClick={onRecheck}>
            {checking ? "Checking…" : "Check again"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
