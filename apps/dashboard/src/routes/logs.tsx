import { createFileRoute } from "@tanstack/react-router";
import LogsPage from "@/modules/logs/index.page";

export const Route = createFileRoute("/logs")({ staticData: { ownsViewport: true }, component: LogsPage });
