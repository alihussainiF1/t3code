import { useLinkTo } from "@react-navigation/native";
import type { Automation, AutomationRun, EnvironmentId } from "@t3tools/contracts";
import { describeAutomationSchedule } from "@t3tools/shared/automationSchedule";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";

const RUN_STATUS_LABEL: Readonly<Record<AutomationRun["status"], string>> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

const formatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatInstant(iso: string): string {
  const millis = Date.parse(iso);
  return Number.isNaN(millis) ? iso : formatter.format(millis);
}

/**
 * Automations are created and edited on desktop or web; mobile lists them,
 * pauses or resumes them, runs them on demand, and opens their run threads.
 */
export function AutomationsRouteScreen() {
  const insets = useSafeAreaInsets();
  const configs = useServerConfigs();
  const environments = [...configs.entries()]
    .filter(([, config]) => config.environment.capabilities.automations === true)
    .map(([environmentId, config]) => ({ environmentId, label: config.environment.label }));

  return (
    <SettingsScreen title="Automations">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environments.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            None of your connected environments supports automations yet.
          </Text>
        ) : (
          environments.map((environment) => (
            <EnvironmentAutomations
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environments.length > 1 ? environment.label : undefined}
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentAutomations(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | undefined;
}) {
  const { data, error } = useEnvironmentQuery(
    serverEnvironment.automations({ environmentId: props.environmentId, input: {} }),
  );
  const automations = data?.automations ?? [];
  return (
    <View className="gap-4">
      {props.label ? (
        <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
      ) : null}
      {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
      {data && automations.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          No automations yet. Create one from T3 Code on desktop or the web.
        </Text>
      ) : null}
      {automations.map((automation) => (
        <AutomationSection
          key={automation.id}
          environmentId={props.environmentId}
          automation={automation}
        />
      ))}
    </View>
  );
}

function AutomationSection(props: {
  readonly environmentId: EnvironmentId;
  readonly automation: Automation;
}) {
  const { environmentId, automation } = props;
  const updateAutomation = useAtomCommand(serverEnvironment.updateAutomation, {
    label: "update automation",
    reportFailure: true,
  });
  const runNow = useAtomCommand(serverEnvironment.runAutomationNow, {
    label: "run automation",
    reportFailure: true,
  });
  const { data } = useEnvironmentQuery(
    serverEnvironment.automationRuns({
      environmentId,
      input: { automationId: automation.id, limit: 5 },
    }),
  );
  const subtitle = [
    describeAutomationSchedule(automation.schedule),
    automation.enabled && automation.nextRunAt
      ? `next ${formatInstant(automation.nextRunAt)}`
      : "paused",
  ].join(" · ");

  return (
    <SettingsSection title={automation.name}>
      <SettingsSwitchRow
        icon="timer"
        label="Enabled"
        subtitle={subtitle}
        value={automation.enabled}
        onValueChange={(enabled) =>
          void updateAutomation({ environmentId, input: { id: automation.id, enabled } })
        }
      />
      <SettingsActionRow
        icon="play"
        label="Run now"
        onPress={() => void runNow({ environmentId, input: { id: automation.id } })}
      />
      {(data?.runs ?? []).map((run) => (
        <RunRow key={run.id} environmentId={environmentId} run={run} />
      ))}
    </SettingsSection>
  );
}

function RunRow(props: { readonly environmentId: EnvironmentId; readonly run: AutomationRun }) {
  const linkTo = useLinkTo();
  const { run } = props;
  const threadId = run.threadId;
  const label = `${RUN_STATUS_LABEL[run.status]} · ${formatInstant(run.startedAt)}`;
  const content = (
    <View className="gap-0.5 p-4">
      <Text className="text-base text-foreground">{label}</Text>
      {run.detail ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={2}>
          {run.detail}
        </Text>
      ) : null}
    </View>
  );
  if (threadId === null) return content;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open thread for run: ${label}`}
      onPress={() =>
        linkTo(
          `/threads/${encodeURIComponent(props.environmentId)}/${encodeURIComponent(threadId)}`,
        )
      }
    >
      {content}
    </Pressable>
  );
}
