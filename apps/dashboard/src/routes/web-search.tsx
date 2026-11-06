import { createFileRoute } from "@tanstack/react-router";
import WebSearchPage from "@/modules/web-search/index.page";

export const Route = createFileRoute("/web-search")({ component: WebSearchPage });
