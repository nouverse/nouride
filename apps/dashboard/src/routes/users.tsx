import { createFileRoute } from "@tanstack/react-router";
import UsersPage from "@/modules/users/index.page";

export const Route = createFileRoute("/users")({ staticData: { fillsViewport: true }, component: UsersPage });
