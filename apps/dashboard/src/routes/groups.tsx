import { createFileRoute } from "@tanstack/react-router";
import GroupsPage from "@/modules/groups/index.page";

export const Route = createFileRoute("/groups")({ staticData: { fillsViewport: true }, component: GroupsPage });
