/**
 * How an agent's cat looks in Nouride Office (0.8.1): each part a person may pick on the agent's Look tab,
 * kept in its pack as `[look]`. A part left out is the hash of the agent's id, so an agent nobody styled still has a
 * look of its own, and a rename does not change it. The variety is in colour, which is a palette; the shapes stay few,
 * since each is a drawing in every pose — a new colour is a word here and a palette there, a new hat one drawing.
 */

/** Each part: its key in a pack's `[look]`, and the words it takes. */
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
