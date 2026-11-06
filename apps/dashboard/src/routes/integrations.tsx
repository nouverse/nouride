import { createFileRoute } from "@tanstack/react-router";
import IntegrationsPage from "@/modules/integrations/index.page";

export const Route = createFileRoute("/integrations")({ component: IntegrationsPage });
