/**
 * An agent's cat in Nouride Office (0.8.1) — `routes/agent-tools.ts`'s `/agents/:id/look`, and the words each part
 * takes: the daemon's `LOOK_PARTS`, written again because the page offers them at runtime, and typed as the daemon's,
 * so a word one side has and the other does not fails the typecheck.
 */

import { control, post } from "./api.client";
import type { AgentLook, LookParts } from "@nouride/wire";

export const LOOK_PARTS: LookParts = {
  fur: { key: "fur", values: ["ginger", "grey", "black", "white", "brown", "cream"] },
  pattern: { key: "pattern", values: ["plain", "tabby"] },
  outfit: { key: "outfit", values: ["none", "hoodie", "tee", "jacket"] },
  outfitColor: { key: "outfit_color", values: ["blue", "lime", "peach", "charcoal", "sage", "lilac", "white"] },
  hat: { key: "hat", values: ["none", "beanie", "cap", "beret", "headband", "headphones"] },
  accessory: { key: "accessory", values: ["none", "glasses", "sunglasses", "scarf"] },
  eyes: { key: "eyes", values: ["round", "sleepy", "sparkly"] },
};

export const lookApi = {
  /** Operator and up. A part sent empty is its own again, from the agent's id. */
  setAgentLook: (id: string, look: Partial<Record<keyof AgentLook, string>>) => post<{ ok: true }>(`${control}/agents/${id}/look`, look),
};
