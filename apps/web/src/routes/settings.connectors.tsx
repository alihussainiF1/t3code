import { createFileRoute } from "@tanstack/react-router";

import { ConnectorsSettingsPanel } from "../components/settings/ConnectorsSettings";

export const Route = createFileRoute("/settings/connectors")({
  component: ConnectorsSettingsPanel,
});
