import type { Automation, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AUTOMATION_WEEKDAY_NAMES, nextAutomationRuns } from "@t3tools/shared/automationSchedule";
import { createModelSelection } from "@t3tools/shared/model";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  AUTOMATION_SCHEDULE_MODE_LABELS,
  type AutomationFormState,
  type AutomationScheduleMode,
  automationFormFromAutomation,
  automationInputFromForm,
  automationScheduleFromForm,
  emptyAutomationForm,
} from "./automations.logic";

const SCHEDULE_MODES = Object.keys(AUTOMATION_SCHEDULE_MODE_LABELS) as AutomationScheduleMode[];
const MINUTE_OPTIONS = [0, 15, 30, 45] as const;

const previewFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Creates or edits one automation on one environment. Edits keep the
 * environment; creating on a multi-environment client picks one first.
 */
export function AutomationDialog({
  open,
  onOpenChange,
  environmentIds,
  initialEnvironmentId,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Environments that can run automations. */
  environmentIds: ReadonlyArray<EnvironmentId>;
  initialEnvironmentId: EnvironmentId;
  editing: Automation | null;
}) {
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = useEnvironment(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const defaultSelection = resolveDefaultProviderModelSelection(
    providers,
    settings.defaultModelSelection,
  );
  const [form, setForm] = useState<AutomationFormState>(() =>
    editing
      ? automationFormFromAutomation(editing)
      : emptyAutomationForm({
          projectId: projects[0]?.id ?? null,
          modelSelection: defaultSelection,
          runtimeMode: settings.defaultRuntimeMode,
        }),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<AutomationFormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  // Fields left empty (projects still streaming in, or a fresh environment)
  // fall back to that environment's first project and default model.
  const selection = form.modelSelection ?? defaultSelection;
  const projectId = form.projectId ?? projects[0]?.id ?? null;
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );

  const schedule = automationScheduleFromForm(form);
  const [openedAt] = useState(() => Date.now());
  const preview = schedule === null ? [] : nextAutomationRuns(schedule, openedAt, 3);

  const createAutomation = useAtomCommand(serverEnvironment.createAutomation);
  const updateAutomation = useAtomCommand(serverEnvironment.updateAutomation);

  const save = async () => {
    const result = automationInputFromForm(
      { ...form, projectId, modelSelection: selection },
      Date.now(),
    );
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const outcome = editing
        ? await updateAutomation({ environmentId, input: { id: editing.id, ...result.input } })
        : await createAutomation({ environmentId, input: result.input });
      if (outcome._tag === "Success") onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const projectTitle = (projectId: ProjectId | null) =>
    projects.find((project) => project.id === projectId)?.title ?? "Choose a project";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "New automation"}</DialogTitle>
          <DialogDescription>
            The server runs this prompt on schedule, even while this app is closed. Each run's
            thread shows up in the sidebar for review.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="automation-name">Name</Label>
              <Input
                id="automation-name"
                placeholder="Morning issue triage"
                value={form.name}
                onChange={(event) => update({ name: event.target.value })}
                autoFocus
              />
            </div>

            {!editing && environmentIds.length > 1 ? (
              <div className="grid gap-1.5">
                <Label>Environment</Label>
                <EnvironmentSelect
                  environmentIds={environmentIds}
                  value={environmentId}
                  onChange={(next) => {
                    setEnvironmentId(next);
                    update({ projectId: null, modelSelection: null });
                  }}
                />
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <Label>Project</Label>
              <Select
                value={projectId}
                onValueChange={(value) => {
                  if (value) update({ projectId: value });
                }}
              >
                <SelectTrigger aria-label="Project">
                  <SelectValue>{projectTitle(projectId)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="automation-prompt">Prompt</Label>
              <Textarea
                id="automation-prompt"
                placeholder="Review issues opened since yesterday and summarize what needs attention."
                rows={5}
                value={form.prompt}
                onChange={(event) => update({ prompt: event.target.value })}
              />
            </div>

            <div className="grid gap-1.5 sm:grid-cols-2 sm:gap-3">
              <div className="grid gap-1.5">
                <Label>Model</Label>
                {selection ? (
                  <ProviderModelPicker
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptions}
                    onInstanceModelChange={(instanceId, model) =>
                      update({ modelSelection: createModelSelection(instanceId, model) })
                    }
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">No providers available</span>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label>Permissions</Label>
                <Select
                  value={form.runtimeMode}
                  onValueChange={(value) => {
                    if (value) update({ runtimeMode: value });
                  }}
                >
                  <SelectTrigger aria-label="Permissions">
                    <SelectValue>{runtimeModeConfig[form.runtimeMode].label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {runtimeModeOptions.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {runtimeModeConfig[mode].label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Schedule</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={form.scheduleMode}
                  onValueChange={(value) => {
                    if (value) update({ scheduleMode: value });
                  }}
                >
                  <SelectTrigger aria-label="Schedule" className="w-40">
                    <SelectValue>{AUTOMATION_SCHEDULE_MODE_LABELS[form.scheduleMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {SCHEDULE_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {AUTOMATION_SCHEDULE_MODE_LABELS[mode]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {form.scheduleMode === "weekly" ? (
                  <Select
                    value={form.weekday}
                    onValueChange={(value) => {
                      if (value !== null) update({ weekday: value });
                    }}
                  >
                    <SelectTrigger aria-label="Day of week" className="w-36">
                      <SelectValue>{AUTOMATION_WEEKDAY_NAMES[form.weekday]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {AUTOMATION_WEEKDAY_NAMES.map((day, index) => (
                        <SelectItem key={day} value={index}>
                          {day}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
                {form.scheduleMode === "hourly" ? (
                  <Select
                    value={form.minute}
                    onValueChange={(value) => {
                      if (value !== null) update({ minute: value });
                    }}
                  >
                    <SelectTrigger aria-label="Minute past the hour" className="w-36">
                      <SelectValue>{`At :${String(form.minute).padStart(2, "0")}`}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {MINUTE_OPTIONS.map((minute) => (
                        <SelectItem key={minute} value={minute}>
                          {`At :${String(minute).padStart(2, "0")}`}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
                {form.scheduleMode === "daily" ||
                form.scheduleMode === "weekdays" ||
                form.scheduleMode === "weekly" ? (
                  <Input
                    aria-label="Time"
                    type="time"
                    className="w-32"
                    value={form.time}
                    onChange={(event) => update({ time: event.target.value })}
                  />
                ) : null}
                {form.scheduleMode === "custom" ? (
                  <Input
                    aria-label="Cron expression"
                    className="w-44"
                    placeholder="0 9 * * 1-5"
                    value={form.customCron}
                    onChange={(event) => update({ customCron: event.target.value })}
                  />
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="automation-timezone">Time zone</Label>
                <Input
                  id="automation-timezone"
                  className="w-56"
                  value={form.timezone}
                  onChange={(event) => update({ timezone: event.target.value })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {preview.length > 0
                  ? `Next runs: ${preview.map((run) => previewFormatter.format(run)).join(" · ")}`
                  : "This schedule has no upcoming runs."}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label>Each run</Label>
              <Select
                value={form.target}
                onValueChange={(value) => {
                  if (value) update({ target: value });
                }}
              >
                <SelectTrigger aria-label="Run target">
                  <SelectValue>
                    {form.target === "new-thread"
                      ? "Starts a new thread"
                      : "Continues the same thread"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="new-thread">Starts a new thread</SelectItem>
                  <SelectItem value="same-thread">Continues the same thread</SelectItem>
                </SelectPopup>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="automation-enabled">Enabled</Label>
              <Switch
                id="automation-enabled"
                checked={form.enabled}
                onCheckedChange={(enabled) => update({ enabled })}
              />
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {editing ? "Save" : "Create automation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function EnvironmentSelect({
  environmentIds,
  value,
  onChange,
}: {
  environmentIds: ReadonlyArray<EnvironmentId>;
  value: EnvironmentId;
  onChange: (environmentId: EnvironmentId) => void;
}) {
  const current = useEnvironment(value);
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger aria-label="Environment">
        <SelectValue>{current?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {environmentIds.map((environmentId) => (
          <EnvironmentOption key={environmentId} environmentId={environmentId} />
        ))}
      </SelectPopup>
    </Select>
  );
}

function EnvironmentOption({ environmentId }: { environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  return <SelectItem value={environmentId}>{environment?.label ?? environmentId}</SelectItem>;
}
