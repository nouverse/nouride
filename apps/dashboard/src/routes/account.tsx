import { createFileRoute } from "@tanstack/react-router";
import AccountPage from "@/modules/account/index.page";

export const Route = createFileRoute("/account")({ component: AccountPage });
