/**
 * Skills settings - the environment's skill library. Skills live on that
 * environment's server, which hands the enabled ones to every provider
 * session; this page installs, edits, updates, and imports them.
 *
 * @module SkillsSettings
 */
import {
  type DiscoveredSkill,
  type EnvironmentId,
  type ProviderDriverKind,
  SKILL_GALLERY,
  type SkillConfig,
  type SkillGalleryEntry,
  type SkillId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DownloadIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import { Label } from "../ui/label";
import { RefreshIcon } from "../ui/refresh-icon";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderAllowlist } from "./ConnectorDialog";
import { connectorProvidersSummary } from "./ConnectorsSettings.logic";
import {
  type ProviderOperateAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { getDriverOption } from "./providerDriverMeta";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  galleryInstallState,
  importableDiscoveredSkills,
  NEW_SKILL_TEMPLATE,
  SKILL_DISCOVERY_SOURCE_LABELS,
  skillCanUpdate,
  skillSourceLabel,
} from "./SkillsSettings.logic";

const EMPTY_DISCOVERED: ReadonlyArray<DiscoveredSkill> = [];

function errorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** The library is machine state, so the page shows the environment the scope selector picked. */
export function SkillsSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  // A project scope lets discovery read that project's `.claude/skills` and `.agents/skills`.
  const cwd =
    environment && (scope.kind === "project" || scope.kind === "checkout")
      ? (scope.members.find((member) => member.environmentId === environment.environmentId)
          ?.workspaceRoot ?? null)
      : null;
  return (
    <SettingsPageContainer>
      {environment === null ? (
        <SettingsSection title="Skills">
          <SettingsRow
            title={
              scope.kind === "environment"
                ? `Reconnect ${scope.label} to manage its skills.`
                : "Connect an environment to manage its skills."
            }
          />
        </SettingsSection>
      ) : environment.serverConfig?.environment.capabilities.skills !== true ? (
        <SettingsSection title="Skills">
          <SettingsRow
            title={`Update the server on ${environment.label} to use skills.`}
            description="The skill library needs a newer T3 Code server."
          />
        </SettingsSection>
      ) : (
        <AccessGatedSkills key={environment.environmentId} environment={environment} cwd={cwd} />
      )}
    </SettingsPageContainer>
  );
}

function AccessGatedSkills(props: {
  readonly environment: EnvironmentPresentation;
  readonly cwd: string | null;
}) {
  if (props.environment.entry.target._tag !== "PrimaryConnectionTarget") {
    return <RemoteSessionSkills {...props} />;
  }
  return isElectron ? (
    <EnvironmentSkills {...props} access="granted" />
  ) : (
    <PrimarySessionSkills {...props} />
  );
}

function PrimarySessionSkills(props: {
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
  return <EnvironmentSkills {...props} access={access} />;
}

function RemoteSessionSkills(props: {
  readonly environment: EnvironmentPresentation;
  readonly cwd: string | null;
}) {
  const session = useEnvironmentSessionState(props.environment.environmentId);
  const access = resolveRemoteOperateAccess({
    session: session.data,
    isPending: session.isPending,
    hasError: session.hasError,
  });
  return <EnvironmentSkills {...props} access={access} />;
}

type EditorTarget = { readonly id: SkillId; readonly config: SkillConfig } | "new";

function EnvironmentSkills({
  environment,
  cwd,
  access,
}: {
  readonly environment: EnvironmentPresentation;
  readonly cwd: string | null;
  readonly access: ProviderOperateAccess;
}) {
  const environmentId = environment.environmentId;
  const readOnly = access !== "granted";
  const skills = useEnvironmentSettings(environmentId, (settings) => settings.skills);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const installSkill = useAtomCommand(serverEnvironment.installSkill, { reportFailure: false });
  const updateSkill = useAtomCommand(serverEnvironment.updateSkill, { label: "update skill" });
  const deleteSkill = useAtomCommand(serverEnvironment.deleteSkill, { label: "delete skill" });
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const entries = useMemo(
    () =>
      (Object.entries(skills) as Array<[SkillId, SkillConfig]>).toSorted(([, left], [, right]) =>
        left.name.localeCompare(right.name),
      ),
    [skills],
  );

  /** One-click install; reports what was skipped so a partial install is not silent. */
  const install = async (url: string, key: string) => {
    setBusy(key);
    try {
      const result = await installSkill({ environmentId, input: { url } });
      if (result._tag !== "Success") {
        toastManager.add({
          type: "error",
          title: "Could not install skill",
          description: errorMessage(result),
        });
        return false;
      }
      const { skillIds, skipped } = result.value;
      toastManager.add({
        type: skipped.length > 0 ? "warning" : "success",
        title: `Installed ${skillIds.join(", ")}`,
        ...(skipped.length > 0
          ? {
              description: `Skipped ${skipped.map((entry) => `${entry.path} (${entry.reason})`).join("; ")}`,
            }
          : {}),
      });
      return true;
    } finally {
      setBusy(null);
    }
  };

  const runUpdate = async (id: SkillId) => {
    setBusy(`update:${id}`);
    try {
      const result = await updateSkill({ environmentId, input: { skillId: id } });
      if (result._tag === "Success") toastManager.add({ type: "success", title: `Updated ${id}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("skills")}
        headerAction={
          !readOnly ? (
            <div className="flex gap-1">
              <Button size="xs" variant="outline" onClick={() => setUrlDialogOpen(true)}>
                <DownloadIcon className="size-3" aria-hidden />
                Install from GitHub
              </Button>
              <Button size="xs" variant="outline" onClick={() => setEditor("new")}>
                <PlusIcon className="size-3" aria-hidden />
                New skill
              </Button>
            </div>
          ) : null
        }
      >
        {readOnly && access === "denied" ? (
          <SettingsRow
            title="View only"
            description={`This session can view ${environment.label}'s skills but can't change them.`}
          />
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow
            title="No skills yet."
            description="Install one from the gallery, import the skills you already use, or write your own. Every provider session on this environment gets them, and threads can turn them off individually."
          />
        ) : (
          entries.map(([id, config]) => {
            const providers = connectorProvidersSummary(
              config.providers,
              (driver) => getDriverOption(driver)?.label ?? driver,
            );
            return (
              <SettingsRow
                key={id}
                title={config.name}
                description={
                  <span className="break-all">
                    <span className="line-clamp-2">{config.description}</span>
                    <span className="text-muted-foreground/70">
                      ${id} · {skillSourceLabel(config.source)}
                      {providers ? ` · ${providers}` : ""}
                    </span>
                  </span>
                }
                control={
                  <>
                    {!readOnly ? (
                      <>
                        {skillCanUpdate(config.source) ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => void runUpdate(id)}
                          >
                            {busy === `update:${id}` ? "Updating…" : "Update"}
                          </Button>
                        ) : null}
                        <Button size="xs" variant="ghost" onClick={() => setEditor({ id, config })}>
                          Edit
                        </Button>
                        <DeleteSkillButton
                          name={config.name}
                          onConfirm={() =>
                            void deleteSkill({ environmentId, input: { skillId: id } })
                          }
                        />
                      </>
                    ) : null}
                    <Switch
                      aria-label={`Enable ${config.name}`}
                      checked={config.enabled}
                      disabled={readOnly}
                      onCheckedChange={(enabled) =>
                        updateSettings({ skills: { [id]: { ...config, enabled } } })
                      }
                    />
                  </>
                }
              />
            );
          })
        )}
      </SettingsSection>
      <SettingsSection {...searchableSetting("skills-gallery")}>
        <div className="grid gap-2 p-3 sm:grid-cols-2 sm:p-4">
          {SKILL_GALLERY.map((entry) => (
            <GalleryTile
              key={entry.url}
              entry={entry}
              state={galleryInstallState(entry, skills)}
              readOnly={readOnly}
              installing={busy === entry.url}
              disabled={busy !== null}
              onInstall={() => void install(entry.url, entry.url)}
            />
          ))}
        </div>
      </SettingsSection>
      <ImportSkillsSection environmentId={environmentId} cwd={cwd} readOnly={readOnly} />
      {urlDialogOpen && !readOnly ? (
        <InstallFromUrlDialog
          onOpenChange={setUrlDialogOpen}
          installing={busy === "url"}
          onInstall={async (url) => {
            if (await install(url, "url")) setUrlDialogOpen(false);
          }}
        />
      ) : null}
      {editor !== null && !readOnly ? (
        <SkillEditorDialog
          environmentId={environmentId}
          target={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </>
  );
}

function GalleryTile(props: {
  readonly entry: SkillGalleryEntry;
  readonly state: ReturnType<typeof galleryInstallState>;
  readonly readOnly: boolean;
  readonly installing: boolean;
  readonly disabled: boolean;
  readonly onInstall: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">{props.entry.id}</span>
        <Badge variant="secondary">{props.entry.publisher}</Badge>
      </div>
      <p className="line-clamp-2 flex-1 text-xs text-muted-foreground">{props.entry.description}</p>
      <div className="flex justify-end">
        {props.state === "installed" ? (
          <Badge variant="success">Installed</Badge>
        ) : props.state === "name-taken" ? (
          <Badge variant="warning">Name in use</Badge>
        ) : props.readOnly ? null : (
          <Button size="xs" variant="outline" disabled={props.disabled} onClick={props.onInstall}>
            {props.installing ? "Installing…" : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
}

function InstallFromUrlDialog(props: {
  readonly onOpenChange: (open: boolean) => void;
  readonly installing: boolean;
  readonly onInstall: (url: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Install from GitHub</DialogTitle>
          <DialogDescription>
            A skill folder installs that skill; a repository or folder of skills installs every
            skill in it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (url.trim()) void props.onInstall(url.trim());
            }}
          >
            <Label htmlFor="skill-url">URL</Label>
            <Input
              id="skill-url"
              placeholder="https://github.com/owner/repo/tree/main/skills/name"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoFocus
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={props.installing || url.trim().length === 0}
            onClick={() => void props.onInstall(url.trim())}
          >
            {props.installing ? "Installing…" : "Install"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Writes SKILL.md (and the provider allowlist) through the server, which validates the frontmatter. */
function SkillEditorDialog({
  environmentId,
  target,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: EditorTarget;
  readonly onClose: () => void;
}) {
  const editing = target === "new" ? null : target;
  const readSkill = useAtomCommand(serverEnvironment.readSkill, { reportFailure: false });
  const saveSkill = useAtomCommand(serverEnvironment.saveSkill, { reportFailure: false });
  const [content, setContent] = useState<string | null>(editing ? null : NEW_SKILL_TEMPLATE);
  const [files, setFiles] = useState<ReadonlyArray<string>>([]);
  const [providers, setProviders] = useState<ReadonlyArray<ProviderDriverKind> | null>(
    editing?.config.providers ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editingId = editing?.id;

  useEffect(() => {
    if (editingId === undefined) return;
    let cancelled = false;
    void readSkill({ environmentId, input: { skillId: editingId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setContent(result.value.content);
        setFiles(result.value.files);
      } else {
        setError(errorMessage(result));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, editingId, readSkill]);

  const save = async () => {
    if (content === null) return;
    setSaving(true);
    try {
      const result = await saveSkill({
        environmentId,
        input: {
          ...(editing ? { skillId: editing.id } : {}),
          content,
          providers: providers === null ? null : [...providers],
        },
      });
      if (result._tag !== "Success") {
        setError(errorMessage(result));
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.config.name}` : "New skill"}</DialogTitle>
          <DialogDescription>
            SKILL.md needs a <code>name</code> and a <code>description</code> in its frontmatter;
            agents decide when to use the skill from the description.
            {editing && editing.config.source.type !== "local"
              ? " Updating from the source replaces your edits."
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <Textarea
              aria-label="SKILL.md"
              className="min-h-80"
              value={content ?? ""}
              disabled={content === null}
              placeholder={content === null ? "Loading…" : undefined}
              onChange={(event) => {
                setContent(event.target.value);
                setError(null);
              }}
              spellCheck={false}
            />
            {files.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Also in this skill: {files.slice(0, 12).join(", ")}
                {files.length > 12 ? `, and ${files.length - 12} more` : ""}
              </p>
            ) : null}
            <ProviderAllowlist providers={providers} onChange={(next) => setProviders(next)} />
            {error ? <p className="text-xs whitespace-pre-wrap text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || content === null} onClick={() => void save()}>
            {saving ? "Saving…" : editing ? "Save" : "Create skill"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteSkillButton({
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
              Its folder is removed from this environment and provider sessions stop receiving it.
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
              Delete skill
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** Skills already installed for a provider CLI on this environment, ready to adopt. */
function ImportSkillsSection({
  environmentId,
  cwd,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly readOnly: boolean;
}) {
  const discovery = useEnvironmentQuery(
    serverEnvironment.discoverSkills({ environmentId, input: cwd ? { cwd } : {} }),
  );
  const importSkills = useAtomCommand(serverEnvironment.importSkills, { label: "import skills" });
  const [importing, setImporting] = useState<string | null>(null);
  const discovered = discovery.data?.skills ?? EMPTY_DISCOVERED;
  const importable = useMemo(() => importableDiscoveredSkills(discovered), [discovered]);

  const runImport = async (paths: ReadonlyArray<string>, key: string) => {
    setImporting(key);
    try {
      const result = await importSkills({
        environmentId,
        input: { paths: [...paths], ...(cwd ? { cwd } : {}) },
      });
      if (result._tag === "Success") {
        discovery.refresh();
        if (result.value.skipped.length > 0) {
          toastManager.add({
            type: "warning",
            title: `Skipped ${result.value.skipped.length} skill${result.value.skipped.length === 1 ? "" : "s"}`,
            description: result.value.skipped
              .map((entry) => `${entry.path}: ${entry.reason}`)
              .join("\n"),
          });
        }
      }
    } finally {
      setImporting(null);
    }
  };

  return (
    <SettingsSection
      {...searchableSetting("skills-import")}
      headerAction={
        <div className="flex items-center gap-1">
          {!readOnly && importable.length > 1 ? (
            <Button
              size="xs"
              variant="outline"
              disabled={importing !== null}
              onClick={() =>
                void runImport(
                  importable.map((skill) => skill.path),
                  "all",
                )
              }
            >
              {importing === "all" ? "Importing…" : `Import all (${importable.length})`}
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  onClick={discovery.refresh}
                  disabled={discovery.isPending}
                  aria-label="Rescan skill folders"
                >
                  <RefreshIcon refreshing={discovery.isPending} />
                </Button>
              }
            />
            <TooltipPopup side="top">Rescan skill folders</TooltipPopup>
          </Tooltip>
        </div>
      }
    >
      {discovery.error ? (
        <SettingsRow title="Could not scan for skills." description={discovery.error} />
      ) : discovered.length === 0 ? (
        <SettingsRow
          title={discovery.isPending ? "Scanning…" : "No skills found."}
          description="Looks in ~/.claude/skills, ~/.codex/skills, ~/.agents/skills, and the selected project's .claude/skills and .agents/skills."
        />
      ) : (
        discovered.map((skill) => (
          <SettingsRow
            key={skill.path}
            title={skill.name}
            description={
              <span className="break-all">
                {SKILL_DISCOVERY_SOURCE_LABELS[skill.source]} · {skill.path}
              </span>
            }
            status={skill.note ?? null}
            control={
              readOnly ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    skill.note !== undefined || skill.importedAs !== undefined || importing !== null
                  }
                  onClick={() => void runImport([skill.path], skill.path)}
                >
                  {skill.importedAs !== undefined
                    ? "Imported"
                    : importing === skill.path
                      ? "Importing…"
                      : "Import"}
                </Button>
              )
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
