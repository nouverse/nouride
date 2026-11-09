/**
 * Each agent's look in the Office (0.8.1): what its pack picks, part by part, and the rest from a hash of its id — so
 * an agent nobody styled has a look of its own, a rename does not change it, and the hash is versioned, so a better
 * generator later does not reshuffle everyone. No two agents in one office are twins: a look the hash gives that an
 * earlier agent already has moves its outfit colour on, then its fur, where the pack left those to the hash.
 *
 * The hash reads look-v1's words, whatever a part takes now: it takes the remainder of the part's word count, so a word
 * more or fewer would have changed nearly every cat nobody styled. A word added since (white; tuxedo, the helmet, the photochromic glasses) is one a person picks;
 * one that moved (headphones, a hat since 0.8.1, an accessory before) stays where the hash put it, as what it is now.
 */

import { LOOK_PARTS } from "@/commons/lib/api.look";
import type { AgentLook } from "@nouride/wire";

export type Look = Required<AgentLook>;

const VERSION = "look-v1";
/** look-v1's words, where a part's have changed since: the ones the hash gives, and a twin moves among. */
const V1_WORDS: Partial<Record<keyof Look, readonly string[]>> = {
  pattern: ["plain", "tabby"],
  outfitColor: ["blue", "lime", "peach", "charcoal", "sage", "lilac"],
  hat: ["none", "beanie", "cap", "beret", "headband"],
  accessory: ["none", "glasses", "sunglasses", "headphones", "scarf"],
};
const hashedWords = (part: keyof Look): readonly string[] => V1_WORDS[part] ?? (LOOK_PARTS[part].values as readonly string[]);

/** FNV-1a: a small hash that spreads short ids well, and is the same in every browser. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** One agent's look: its own parts, the hash's for the rest. */
export function lookOf(id: string, own: AgentLook = {}): Look {
  const pick = <Part extends keyof Look>(part: Part): Look[Part] => {
    const values = hashedWords(part) as unknown as readonly Look[Part][];
    return (own[part] as Look[Part] | undefined) ?? values[hash(`${VERSION}:${id}:${part}`) % values.length]!;
  };
  const look = {
    fur: pick("fur"),
    pattern: pick("pattern"),
    outfit: pick("outfit"),
    outfitColor: pick("outfitColor"),
    hat: pick("hat"),
    accessory: pick("accessory"),
    eyes: pick("eyes"),
  };
  // Headphones the hash gave as an accessory are worn as the hat they are now — where the cat had no hat; under a cap or
  // a beanie they are left off, the hat being what it has worn all along. A hat picked, even none, keeps them off.
  if ((look.accessory as string) !== "headphones") return look;
  return { ...look, accessory: "none", hat: look.hat === "none" && own.hat === undefined ? "headphones" : look.hat };
}

const sameLook = (a: Look, b: Look) => (Object.keys(a) as (keyof Look)[]).every((part) => a[part] === b[part]);

/** Every agent's look in one office, by id, none a twin of another the hash could have moved. */
export function looksOf(agents: readonly { id: string; look?: AgentLook }[]): Map<string, Look> {
  const looks = new Map<string, Look>();
  for (const agent of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
    let look = lookOf(agent.id, agent.look);
    for (const part of ["outfitColor", "fur"] as const) {
      if (agent.look?.[part]) continue;
      const values = hashedWords(part);
      for (let step = 0; step < values.length && [...looks.values()].some((other) => sameLook(other, look)); step += 1) {
        look = { ...look, [part]: values[(values.indexOf(look[part]) + 1) % values.length] } as Look;
      }
    }
    looks.set(agent.id, look);
  }
  return looks;
}
