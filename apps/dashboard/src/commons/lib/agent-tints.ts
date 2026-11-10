/**
 * Each agent's colour: its name above its reply, its tag in a message, the ring round the orchestrator's cat.
 *
 * Taken from the outfit alone it was grey for a charcoal or a white outfit, and two agents in one lilac read as one
 * voice: the owner looked at a room and asked where the colour was. So each agent gets a hue of its own from one set
 * of clear ones, its outfit's hue where that one is still free, the next free one where it is not or where the outfit
 * has none, the orchestrator choosing first. Past the set's size hues repeat, in the same order.
 */

import type { Look } from "@/commons/cat/look";

/** The hues, in the order a free one is taken. Clear on either theme once drawn toward the text colour. */
const HUES = ["#e8735a", "#d99a2b", "#78ad38", "#2a9f96", "#3a95dd", "#8b6be0", "#d95a98", "#5b6ee8"] as const;

/** The hue an outfit colour asks for; a charcoal or a white outfit asks for none. */
const OUTFIT_HUE: Partial<Record<Look["outfitColor"], (typeof HUES)[number]>> = {
  peach: "#e8735a",
  lime: "#78ad38",
  sage: "#2a9f96",
  blue: "#3a95dd",
  lilac: "#8b6be0",
};

/** Every agent's colour, by id: the orchestrator first, then the agents in the order given. */
export function agentTints(agents: readonly { id: string; look?: Look }[], orchestrator?: string | null): Map<string, string> {
  const order = [...agents].sort((a, b) => Number(b.id === orchestrator) - Number(a.id === orchestrator));
  const taken = new Map<string, number>();
  const uses = (hue: string) => taken.get(hue) ?? 0;
  const chosen = new Map<string, string>();
  const take = (id: string, hue: string) => {
    taken.set(hue, uses(hue) + 1);
    chosen.set(id, hue);
  };
  const ownHue = (agent: { look?: Look }) => (agent.look ? OUTFIT_HUE[agent.look.outfitColor] : undefined);
  // Each outfit's own hue first, while it is free: an agent left without one must not take the hue another's outfit asks
  // for, or a peach outfit came out amber because a second lilac had taken the coral before it.
  for (const agent of order) {
    const own = ownHue(agent);
    if (own && uses(own) === 0) take(agent.id, own);
  }
  for (const agent of order) {
    if (chosen.has(agent.id)) continue;
    // The fewest times taken wins, so a ninth agent repeats the first hue rather than piling on one.
    const fewest = Math.min(...HUES.map(uses));
    const own = ownHue(agent);
    take(agent.id, own && uses(own) === fewest ? own : HUES.find((one) => uses(one) === fewest)!);
  }
  return new Map(agents.map((agent) => [agent.id, `color-mix(in oklab, ${chosen.get(agent.id)} 70%, var(--color-base-content))`]));
}
