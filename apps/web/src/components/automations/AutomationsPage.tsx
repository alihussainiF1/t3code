import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { describeAutomationSchedule } from "@t3tools/shared/automationSchedule";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useProjects } from "../../state/entities";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AutomationDialog } from "./AutomationDialog";
import { localTimeZone } from "./automations.logic";

const RUN_STATUS_BADGE: Readonly<
  Record<AutomationRunStatus, { label: string; variant: "info" | "success" | "error" | "outline" }>
> = {
  running: { label: "Running", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  skipped: { label: "Skipped", variant: "outline" },
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatInstant(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormatter.format(date);
}

function scheduleLabel(automation: Automation): string {
  const description = describeAutomationSchedule(automation.schedule);
  return automation.schedule.timezone === localTimeZone() || description.startsWith("Cron ")
    ? description
    : `${description} (${automation.schedule.timezone})`;
}

interface DialogState {
  readonly environmentId: EnvironmentId;
  readonly editing: Automation | null;
}

export function AutomationsPage({ openNew }: { openNew: boolean }) {
  useEscapeToGoBack();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.automations === true,
  );
  const supportedIds = supported.map((environment) => environment.environmentId);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const firstSupported = supportedIds[0] ?? null;

  // The command palette's "New automation" lands here with ?new=true.
  const activeDialog =
    dialog ??
    (openNew && firstSupported !== null ? { environmentId: firstSupported, editing: null } : null);
  const closeDialog = () => {
    setDialog(null);
    if (openNew) void navigate({ to: "/automations", search: {}, replace: true });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 items-center gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Automations breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1>Automations</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="ms-auto">
              <Button
                size="sm"
                disabled={firstSupported === null}
                onClick={() => {
                  if (firstSupported !== null) {
                    setDialog({ environmentId: firstSupported, editing: null });
                  }
                }}
              >
                <PlusIcon />
                New automation
              </Button>
            </div>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {supported.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect a server that supports automations to schedule agent runs.
              </p>
            ) : (
              <div className="grid gap-8">
                {supported.map((environment) => (
                  <EnvironmentAutomations
                    key={environment.environmentId}
                    environment={environment}
                    showLabel={supported.length > 1}
                    onEdit={(automation) =>
                      setDialog({ environmentId: environment.environmentId, editing: automation })
                    }
                  />
                ))}
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {activeDialog ? (
        <AutomationDialog
          key={`${activeDialog.environmentId}:${activeDialog.editing?.id ?? "new"}`}
          open
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
          environmentIds={supportedIds}
          initialEnvironmentId={activeDialog.environmentId}
          editing={activeDialog.editing}
        />
      ) : null}
    </SidebarInset>
  );
}

function EnvironmentAutomations({
  environment,
  showLabel,
  onEdit,
}: {
  environment: EnvironmentPresentation;
  showLabel: boolean;
  onEdit: (automation: Automation) => void;
}) {
  const environmentId = environment.environmentId;
  const query = useEnvironmentQuery(serverEnvironment.automations({ environmentId, input: {} }));
  const automations = query.data?.automations ?? [];
  return (
    <section className="grid gap-3">
      {showLabel ? <h2 className="text-sm font-medium">{environment.label}</h2> : null}
      {query.error ? <p className="text-sm text-destructive">{query.error}</p> : null}
      {automations.length === 0 && !query.isPending ? (
        <p className="text-sm text-muted-foreground">
          No automations yet. Create one to run a prompt on a schedule.
        </p>
      ) : null}
      <ul className="grid gap-3">
        {automations.map((automation) => (
          <AutomationRow
            key={automation.id}
            environmentId={environmentId}
            automation={automation}
            onEdit={() => onEdit(automation)}
          />
        ))}
      </ul>
    </section>
  );
}

function AutomationRow({
  environmentId,
  automation,
  onEdit,
}: {
  environmentId: EnvironmentId;
  automation: Automation;
  onEdit: () => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const projectTitle =
    useProjects().find(
      (project) => project.environmentId === environmentId && project.id === automation.projectId,
    )?.title ?? "Missing project";
  const updateAutomation = useAtomCommand(serverEnvironment.updateAutomation);
  const deleteAutomation = useAtomCommand(serverEnvironment.deleteAutomation);
  const runNow = useAtomCommand(serverEnvironment.runAutomationNow);
  const lastRun = automation.lastRun;

  return (
    <li className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate font-medium">{automation.name}</span>
          <span className="text-xs text-muted-foreground">
            {projectTitle} · {scheduleLabel(automation)}
          </span>
          <span className="text-xs text-muted-foreground">
            {automation.enabled && automation.nextRunAt
              ? `Next run ${formatInstant(automation.nextRunAt)}`
              : "Paused"}
            {lastRun ? ` · Last run ${formatRelativeTimeLabel(lastRun.startedAt)}` : ""}
          </span>
        </div>
        {lastRun ? (
          <Badge variant={RUN_STATUS_BADGE[lastRun.status].variant}>
            {RUN_STATUS_BADGE[lastRun.status].label}
          </Badge>
        ) : null}
        <Switch
          aria-label={automation.enabled ? "Pause automation" : "Enable automation"}
          checked={automation.enabled}
          onCheckedChange={(enabled) =>
            void updateAutomation({ environmentId, input: { id: automation.id, enabled } })
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="xs"
          variant="outline"
          onClick={() => void runNow({ environmentId, input: { id: automation.id } })}
        >
          Run now
        </Button>
        <Button size="xs" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setShowHistory((value) => !value)}>
          {showHistory ? "Hide history" : "History"}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
      </div>
      {showHistory ? (
        <AutomationHistory environmentId={environmentId} automation={automation} />
      ) : null}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {automation.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Future runs stop and the run history is removed. Threads from past runs stay in the
              sidebar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                void deleteAutomation({ environmentId, input: { id: automation.id } });
              }}
            >
              Delete automation
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

function AutomationHistory({
  environmentId,
  automation,
}: {
  environmentId: EnvironmentId;
  automation: Automation;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.automationRuns({
      environmentId,
      input: { automationId: automation.id, limit: 20 },
    }),
  );
  const runs = query.data?.runs ?? [];
  if (runs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {query.isPending ? "Loading history…" : "No runs yet."}
      </p>
    );
  }
  return (
    <ul className="grid gap-1 border-t pt-2">
      {runs.map((run) => (
        <AutomationRunRow key={run.id} environmentId={environmentId} run={run} />
      ))}
    </ul>
  );
}

function AutomationRunRow({
  environmentId,
  run,
}: {
  environmentId: EnvironmentId;
  run: AutomationRun;
}) {
  const badge = RUN_STATUS_BADGE[run.status];
  return (
    <li className="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant={badge.variant}>{badge.label}</Badge>
      <span className="text-muted-foreground">
        {formatInstant(run.startedAt)}
        {run.trigger === "manual" ? " · manual" : ""}
      </span>
      {run.detail ? <span className="text-muted-foreground">· {run.detail}</span> : null}
      {run.threadId ? (
        <Link
          className="ms-auto text-primary hover:underline"
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: run.threadId }}
        >
          Open thread
        </Link>
      ) : null}
    </li>
  );
}
