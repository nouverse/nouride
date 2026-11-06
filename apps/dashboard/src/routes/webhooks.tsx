import { createFileRoute } from "@tanstack/react-router";
import WebhooksPage from "@/modules/webhooks/index.page";

export const Route = createFileRoute("/webhooks")({ staticData: { fillsViewport: true }, component: WebhooksPage });
