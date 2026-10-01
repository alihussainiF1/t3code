import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";

/**
 * Threads only show an unread dot once they have a last-visited time, and a
 * thread an automation started has never been visited. Seeding that time with
 * the run's start makes the run's finished turn count as unseen, so results
 * land in the sidebar like any other completed work.
 */
export function AutomationThreadUnreadSeeder() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments
        .filter(
          (environment) => environment.serverConfig?.environment.capabilities.automations === true,
        )
        .map((environment) => (
          <EnvironmentSeeder
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ))}
    </>
  );
}

function EnvironmentSeeder({ environmentId }: { environmentId: EnvironmentId }) {
  const { data } = useEnvironmentQuery(serverEnvironment.automations({ environmentId, input: {} }));
  useEffect(() => {
    if (!data) return;
    const store = useUiStateStore.getState();
    for (const automation of data.automations) {
      const run = automation.lastRun;
      if (run === null || run.threadId === null) continue;
      const key = scopedThreadKey(scopeThreadRef(environmentId, run.threadId));
      if (store.threadLastVisitedAtById[key] === undefined) {
        store.markThreadVisited(key, run.startedAt);
      }
    }
  }, [data, environmentId]);
  return null;
}
