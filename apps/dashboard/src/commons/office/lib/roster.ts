/**
 * Who is in this office (0.8.1): at most `IN_OFFICE` agents — the orchestrator always, at the desk at the front, then
 * the agents made first — and the rest counted as in another office. Twelve fit three to a row in four rows besides the
 * orchestrator's, the whole office on a laptop's screen with every name readable; more made the page scroll and the
 * names crowd. A number of ours, not a setting. Pure: agents in, who is here and who is away out.
 */

export const IN_OFFICE = 12;

export function roster<Agent extends { id: string; since?: number | null }>(
  agents: readonly Agent[],
  orchestrator: string | null,
  room = IN_OFFICE,
): { here: Agent[]; away: Agent[] } {
  const lead = agents.find((agent) => agent.id === orchestrator);
  // The order they were made in, as the daemon saw it (`since`); those it never dated last, and a tie by id.
  const rest = agents
    .filter((agent) => agent !== lead)
    .sort((a, b) => (a.since ?? Number.POSITIVE_INFINITY) - (b.since ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id));
  const here = [...(lead ? [lead] : []), ...rest].slice(0, room);
  return { here, away: rest.filter((agent) => !here.includes(agent)) };
}
