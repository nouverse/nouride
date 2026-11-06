import { createFileRoute } from "@tanstack/react-router";
import UpdatePage from "@/modules/update/index.page";

export const Route = createFileRoute("/update")({ component: UpdatePage });
