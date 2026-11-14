import { createFileRoute } from "@tanstack/react-router";
import SystemPage from "@/modules/system/index.page";

export const Route = createFileRoute("/system")({ component: SystemPage });
