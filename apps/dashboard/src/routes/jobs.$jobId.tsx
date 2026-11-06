import { createFileRoute } from "@tanstack/react-router";
import JobPage from "@/modules/jobs/job.page";

export const Route = createFileRoute("/jobs/$jobId")({ component: JobRoute });

function JobRoute() {
  const { jobId } = Route.useParams();
  return <JobPage jobId={jobId} />;
}
