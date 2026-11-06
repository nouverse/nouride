/**
 * The Agents module.
 *
 * A layout with nothing of its own — everything an agent has now lives *under* that agent, and this
 * is the seam that makes that true. The dashboard used to spread one agent's settings across four
 * top-level pages: its files here, the bot it answers on there, who may message it somewhere else.
 * Answering "how is Nouva set up" meant visiting all of them and joining the results by hand.
 */

import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/agents")({ component: () => <Outlet /> });
