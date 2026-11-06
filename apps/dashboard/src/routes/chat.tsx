import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/chat")({
  // Every conversation, the index and a room included: the transcript scrolls inside itself, under a header and a
  // composer that stay.
  staticData: { ownsViewport: true },
  component: () => <Outlet />,
});
