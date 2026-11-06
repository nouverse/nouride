import { createFileRoute } from "@tanstack/react-router";
import AgentListPage from "@/modules/agents/index.page";

export const Route = createFileRoute("/agents/")({ staticData: { fillsViewport: true }, component: AgentListPage });
