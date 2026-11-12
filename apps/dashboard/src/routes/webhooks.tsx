import { createFileRoute, redirect } from "@tanstack/react-router";

/** Webhooks is part of Automations. Its address still lands: on the list, narrowed to what starts when its address is called. */
export const Route = createFileRoute("/webhooks")({
  beforeLoad: () => {
    throw redirect({ to: "/automations", search: { start: "webhook" }, replace: true });
  },
});
