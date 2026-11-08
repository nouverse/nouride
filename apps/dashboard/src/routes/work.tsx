import { createFileRoute } from "@tanstack/react-router";
import WorkPage from "@/modules/work/index.page";

export const Route = createFileRoute("/work")({
  component: WorkPage,
});
