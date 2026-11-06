import { createFileRoute } from "@tanstack/react-router";
import MissionPage from "@/modules/missions/mission.page";

export const Route = createFileRoute("/missions/$missionId")({ component: MissionRoute });

function MissionRoute() {
  const { missionId } = Route.useParams();
  return <MissionPage missionId={missionId} />;
}
