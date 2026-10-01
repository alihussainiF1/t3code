import type { McpConnectorConfig, McpConnectorId, ProviderDriverKind } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  type ConnectorAuthType,
  type ConnectorFormState,
  type KeyValueRow,
  REDACTED_SECRET,
  buildConnectorConfig,
  connectorFormFromConfig,
  newKeyValueRow,
  setRowSecret,
} from "./ConnectorsSettings.logic";
import { DRIVER_OPTIONS } from "./providerDriverMeta";

const AUTH_LABELS: Readonly<Record<ConnectorAuthType, string>> = {
  none: "None",
  bearer: "Bearer token",
  oauth: "OAuth",
};

/**
 * Adds or edits one connector. Saved secrets arrive as the redaction marker;
 * leaving a secret field untouched sends the marker back, which keeps the
 * stored value on the server.
 */
export function ConnectorDialog({
  open,
  onOpenChange,
  editing,
  environmentLabel,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The connector being edited, or null to add one. */
  readonly editing: { readonly id: McpConnectorId; readonly config: McpConnectorConfig } | null;
  readonly environmentLabel: string;
  readonly onSave: (config: McpConnectorConfig) => void;
}) {
  const previous = editing?.config ?? null;
  const [form, setForm] = useState<ConnectorFormState>(() => connectorFormFromConfig(previous));
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<ConnectorFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const save = () => {
    const result = buildConnectorConfig(form, previous);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSave(result.config);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.config.name}` : "Add a connector"}</DialogTitle>
          <DialogDescription>
            An MCP server every provider session on {environmentLabel} can use. Secrets stay on that
            server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="connector-name">Name</Label>
              <Input
                id="connector-name"
                placeholder="GitHub"
                value={form.name}
                onChange={(event) => update({ name: event.target.value })}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Transport</Label>
              <ToggleGroup
                aria-label="Transport"
                value={[form.transport]}
                onValueChange={(next) => {
                  const transport = next[0];
                  if (transport === "stdio" || transport === "http") update({ transport });
                }}
              >
                <Toggle value="stdio">Local command</Toggle>
                <Toggle value="http">Remote URL</Toggle>
              </ToggleGroup>
            </div>
            {form.transport === "stdio" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="connector-command">Command</Label>
                  <Input
                    id="connector-command"
                    placeholder="npx"
                    value={form.command}
                    onChange={(event) => update({ command: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="connector-args">Arguments (one per line)</Label>
                  <Textarea
                    id="connector-args"
                    placeholder={"-y\n@modelcontextprotocol/server-github"}
                    value={form.argsText}
                    onChange={(event) => update({ argsText: event.target.value })}
                  />
                </div>
                <KeyValueRows
                  label="Environment variables"
                  addLabel="Add variable"
                  rows={form.env}
                  onChange={(env) => update({ env })}
                />
              </>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="connector-url">URL</Label>
                  <Input
                    id="connector-url"
                    placeholder="https://mcp.example.com/mcp"
                    value={form.url}
                    onChange={(event) => update({ url: event.target.value })}
                  />
                </div>
                <KeyValueRows
                  label="Headers"
                  addLabel="Add header"
                  rows={form.headers}
                  onChange={(headers) => update({ headers })}
                />
                <div className="grid gap-1.5">
                  <Label>Authentication</Label>
                  <Select
                    value={form.authType}
                    onValueChange={(value) => {
                      if (value === "none" || value === "bearer" || value === "oauth") {
                        update({ authType: value });
                      }
                    }}
                  >
                    <SelectTrigger aria-label="Authentication">
                      <SelectValue>{AUTH_LABELS[form.authType]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {(Object.keys(AUTH_LABELS) as ConnectorAuthType[]).map((type) => (
                        <SelectItem key={type} value={type}>
                          {AUTH_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                {form.authType === "bearer" ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="connector-token">Token</Label>
                    <SecretInput
                      id="connector-token"
                      value={form.bearerToken}
                      onChange={(bearerToken) => update({ bearerToken })}
                    />
                  </div>
                ) : null}
                {form.authType === "oauth" ? (
                  <>
                    <div className="grid gap-1.5">
                      <Label htmlFor="connector-scopes">Scopes (optional)</Label>
                      <Input
                        id="connector-scopes"
                        placeholder="Space-separated; empty uses the server's defaults"
                        value={form.oauthScopes}
                        onChange={(event) => update({ oauthScopes: event.target.value })}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="connector-client-id">Client ID (optional)</Label>
                      <Input
                        id="connector-client-id"
                        placeholder="Leave empty to register automatically"
                        value={form.oauthClientId}
                        onChange={(event) => update({ oauthClientId: event.target.value })}
                      />
                    </div>
                  </>
                ) : null}
              </>
            )}
            <ProviderAllowlist
              providers={form.providers}
              onChange={(providers) => update({ providers })}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save}>{editing ? "Save" : "Add connector"}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A password field for a possibly-saved secret. A saved secret shows as an
 * empty field with a "Saved" placeholder; while the field stays empty the
 * marker is kept, so the server keeps the stored value.
 */
function SecretInput({
  id,
  value,
  onChange,
  ariaLabel,
}: {
  readonly id?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ariaLabel?: string;
}) {
  const [hadSavedValue] = useState(value === REDACTED_SECRET);
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      type="password"
      autoComplete="off"
      placeholder={hadSavedValue ? "Saved — leave unchanged" : undefined}
      value={value === REDACTED_SECRET ? "" : value}
      onChange={(event) =>
        onChange(event.target.value === "" && hadSavedValue ? REDACTED_SECRET : event.target.value)
      }
    />
  );
}

function KeyValueRows({
  label,
  addLabel,
  rows,
  onChange,
}: {
  readonly label: string;
  readonly addLabel: string;
  readonly rows: ReadonlyArray<KeyValueRow>;
  readonly onChange: (rows: KeyValueRow[]) => void;
}) {
  const replace = (key: string, next: KeyValueRow) =>
    onChange(rows.map((row) => (row.key === key ? next : row)));
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <Input
            className="w-36 shrink-0"
            aria-label="Name"
            placeholder="NAME"
            value={row.name}
            onChange={(event) => replace(row.key, { ...row, name: event.target.value })}
          />
          <div className="min-w-0 flex-1">
            {row.secret ? (
              <SecretInput
                ariaLabel="Value"
                value={row.value}
                onChange={(value) => replace(row.key, { ...row, value })}
              />
            ) : (
              <Input
                aria-label="Value"
                placeholder="value"
                value={row.value}
                onChange={(event) => replace(row.key, { ...row, value: event.target.value })}
              />
            )}
          </div>
          <Label className="shrink-0">
            <Checkbox
              checked={row.secret}
              onCheckedChange={(checked) => replace(row.key, setRowSecret(row, checked === true))}
            />
            Secret
          </Label>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove ${row.name || "entry"}`}
            onClick={() => onChange(rows.filter((candidate) => candidate.key !== row.key))}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}
      <div>
        <Button size="xs" variant="outline" onClick={() => onChange([...rows, newKeyValueRow()])}>
          <PlusIcon className="size-3" aria-hidden />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

/** "All providers" or a subset; shared with the skill editor. */
export function ProviderAllowlist({
  providers,
  onChange,
}: {
  readonly providers: ReadonlyArray<ProviderDriverKind> | null;
  readonly onChange: (providers: ProviderDriverKind[] | null) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label>
        <Checkbox
          checked={providers === null}
          onCheckedChange={(checked) =>
            onChange(checked === true ? null : DRIVER_OPTIONS.map((option) => option.value))
          }
        />
        All providers
      </Label>
      {providers !== null ? (
        <div className="flex flex-wrap gap-x-4 gap-y-2 pl-6">
          {DRIVER_OPTIONS.map((option) => (
            <Label key={option.value}>
              <Checkbox
                checked={providers.includes(option.value)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...providers, option.value]
                      : providers.filter((driver) => driver !== option.value),
                  )
                }
              />
              {option.label}
            </Label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
