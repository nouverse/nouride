import { createFileRoute } from "@tanstack/react-router";
import BoxPage from "@/modules/box/index.page";

export const Route = createFileRoute("/box")({ component: BoxPage });
