import { createFileRoute } from "@tanstack/react-router";
import WelcomePage from "@/modules/welcome/index.page";

export const Route = createFileRoute("/welcome")({ component: WelcomePage });
