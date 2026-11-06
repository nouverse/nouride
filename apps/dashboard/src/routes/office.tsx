import { createFileRoute } from "@tanstack/react-router";
import OfficePage from "@/modules/office/index.page";

export const Route = createFileRoute("/office")({ component: OfficePage });
