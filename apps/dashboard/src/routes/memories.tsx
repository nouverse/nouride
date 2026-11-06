import { createFileRoute } from "@tanstack/react-router";
import MemoriesPage from "@/modules/memories/index.page";

export const Route = createFileRoute("/memories")({ component: MemoriesPage });
