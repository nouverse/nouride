import { createFileRoute } from "@tanstack/react-router";
import LoginPage from "@/modules/login/index.page";

export const Route = createFileRoute("/login")({ component: LoginPage });
