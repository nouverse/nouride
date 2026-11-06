/**
 * An agent's cat in Nouride Office (0.8.1) — `routes/agent-tools.ts`'s `/agents/:id/look`, and the words each part
 * takes, copied from `@nouride/shared`'s `LOOK_PARTS` (`scripts/check-wire.ts` holds the copy to it).
 */

import { control, post } from "./api.client";

export const LOOK_PARTS = {
  fur: { key: "fur", values: ["ginger", "grey", "black", "white", "brown", "cream"] },
  pattern: { key: "pattern", values: ["plain", "tabby"] },
  outfit: { key: "outfit", values: ["none", "hoodie", "tee", "jacket"] },
  outfitColor: { key: "outfit_color", values: ["blue", "lime", "peach", "charcoal", "sage", "lilac", "white"] },
  hat: { key: "hat", values: ["none", "beanie", "cap", "beret", "headband", "headphones"] },
  accessory: { key: "accessory", values: ["none", "glasses", "sunglasses", "scarf"] },
  eyes: { key: "eyes", values: ["round", "sleepy", "sparkly"] },
} as const;

type Words<Part extends keyof typeof LOOK_PARTS> = (typeof LOOK_PARTS)[Part]["values"][number];

export interface AgentLook {
  fur?: Words<"fur">;
  pattern?: Words<"pattern">;
  outfit?: Words<"outfit">;
  outfitColor?: Words<"outfitColor">;
  hat?: Words<"hat">;
  accessory?: Words<"accessory">;
  eyes?: Words<"eyes">;
}

export const lookApi = {
  /** Operator and up. A part sent empty is its own again, from the agent's id. */
  setAgentLook: (id: string, look: Partial<Record<keyof AgentLook, string>>) => post<{ ok: true }>(`${control}/agents/${id}/look`, look),
};
