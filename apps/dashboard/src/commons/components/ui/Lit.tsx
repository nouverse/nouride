/**
 * A card whose state just changed, lit for a moment (`animate-lit`): a mission that needs you now, a helper that
 * finished. Lit when its state changes while it is drawn, or as it arrives in a list (`arrived`) — a mission whose state
 * changed is drawn anew in the group it moved to — but not as a page first draws it: then nothing changed. Only its
 * light moves, its opacity, and the card stays where it is. Placed inside a card that is `relative`, it takes the card's
 * corners.
 */

import { useState } from "react";

export function Lit({ state, arrived = false }: { state: string; arrived?: boolean }) {
  // The state it was drawn with, and how many times it was lit since: each light is a new element, drawn anew.
  const [seen, setSeen] = useState({ state, lit: arrived ? 1 : 0 });
  if (seen.state !== state) setSeen({ state, lit: seen.lit + 1 });
  if (seen.lit === 0) return null;
  return (
    <span
      key={seen.lit}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-[inherit] bg-primary/10 opacity-0 ring-1 ring-primary/40 animate-lit"
    />
  );
}
