import { createFileRoute } from "@tanstack/react-router";
import PeoplePage from "@/modules/people/index.page";

export const Route = createFileRoute("/people")({ component: PeoplePage });
