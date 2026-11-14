import { createFileRoute, redirect } from "@tanstack/react-router";

/** The Office is the top of the Agents page now: its old address, a bookmark or a link in an answer, lands there. */
export const Route = createFileRoute("/office")({
  beforeLoad: () => {
    throw redirect({ to: "/agents", replace: true });
  },
});
