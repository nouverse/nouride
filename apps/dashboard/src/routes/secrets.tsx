import { createFileRoute } from "@tanstack/react-router";
import SecretsPage from "@/modules/secrets/index.page";

export const Route = createFileRoute("/secrets")({ component: SecretsPage });
