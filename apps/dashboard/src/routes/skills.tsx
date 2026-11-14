import { createFileRoute } from "@tanstack/react-router";
import SkillWorkshopPage from "@/modules/skills/workshop.page";

export const Route = createFileRoute("/skills")({ component: SkillWorkshopPage });
