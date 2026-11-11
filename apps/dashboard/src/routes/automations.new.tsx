import { createFileRoute } from "@tanstack/react-router";
import NewAutomationPage from "@/modules/automations/new.page";

export const Route = createFileRoute("/automations/new")({ component: NewAutomationPage });
