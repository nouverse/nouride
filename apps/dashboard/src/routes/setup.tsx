import { createFileRoute } from "@tanstack/react-router";
import SetupPage from "@/modules/setup/index.page";

export const Route = createFileRoute("/setup")({ component: SetupPage });
