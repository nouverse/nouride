import { createFileRoute } from "@tanstack/react-router";
import HomePage from "@/modules/home/index.page";

export const Route = createFileRoute("/")({ component: HomePage });
