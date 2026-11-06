import { createFileRoute } from "@tanstack/react-router";
import AgentSettingsPage from "@/modules/agents/settings.page";

export const Route = createFileRoute("/agents/settings")({ component: AgentSettingsPage });
