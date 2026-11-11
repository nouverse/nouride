import { createFileRoute, redirect } from "@tanstack/react-router";

/** A job's id as an address may carry it: anything else is dropped, and the list opens. */
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Schedule is part of Automations. Its address still lands: on the list, or, for the link an agent handed a person for
 * one job (`?job=<id>`), on that automation's own page.
 */
export const Route = createFileRoute("/schedule")({
  beforeLoad: ({ location }) => {
    // Read from the address itself, and held to an id here: what reaches the redirect is what goes into the new address.
    const job = (location.search as Record<string, unknown>).job;
    throw typeof job === "string" && JOB_ID.test(job) ? redirect({ to: "/automations/$id", params: { id: job }, replace: true }) : redirect({ to: "/automations", replace: true });
  },
});
