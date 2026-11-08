import { createFileRoute } from "@tanstack/react-router";
import SettingsPage from "@/modules/settings/index.page";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});
