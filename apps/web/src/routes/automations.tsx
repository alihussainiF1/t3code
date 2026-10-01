import { createFileRoute } from "@tanstack/react-router";

import { AutomationsPage } from "../components/automations/AutomationsPage";

export interface AutomationsSearch {
  readonly new?: true;
}

export const Route = createFileRoute("/automations")({
  validateSearch: (raw: Record<string, unknown>): AutomationsSearch =>
    raw.new === true || raw.new === "true" ? { new: true } : {},
  component: AutomationsRoute,
});

function AutomationsRoute() {
  const search = Route.useSearch();
  return <AutomationsPage openNew={search.new === true} />;
}
