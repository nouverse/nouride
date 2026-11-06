/**
 * A gateway renamed, in the agent packs — `rename.ts` does the database and `config.toml`.
 *
 * A pack names gateways in two places, both keyed by the instance id: `[channels] "telegram:bot" = [...]`, the chats it
 * is bound to there, and `[security] sender_allowlist` entries in the qualified form, `telegram:bot:5550001111`. The
 * rename once rewrote only `config.toml`, so after the documented stop, rename, start, every agent bound through
 * `[channels]` failed to load — boot refuses a binding to a gateway it does not have (invariant 7) — and answered
 * nowhere, while the CLI had printed that the rename was done. An allowlist entry on the old id was worse: nothing
 * failed, and that agent stopped answering that person.
 *
 * Each pack's new text is checked the way boot loads it, against the gateways the renamed config will have, before
 * anything is written. A pack that loads today and would not after is a refusal; one already broken is rewritten all
 * the same, since the rename cannot make it worse.
 */

import { join, listDir, parseToml, readTextFileIfExists } from "@nouride/runtime";
import { parseAgentConfig, SHARED_DIR, SKILLS_DIR, type RawAgentConfig } from "@nouride/persona";
import type { LLMDefaultsSection } from "@nouride/shared";
import { mentionsGateway, rewriteConfig } from "./rename.ts";

/** One pack the rename rewrites. */
export interface PackRename {
  id: string;
  /** Its `config.toml`. */
  file: string;
  /** The lines that name the gateway, as they are now. */
  lines: { line: number; text: string }[];
  after: string;
  /** Whether it loads today — and so must still load once written. */
  loads: boolean;
}

/** What boot needs to load a pack's config, beside the gateways — which are the part a rename changes. */
export interface PackCheck {
  defaults: LLMDefaultsSection;
  providers: string[];
}

/** Why this pack's config would not load against these gateways, or null — the parser boot runs (`loader.ts`). */
export function packProblem(id: string, text: string, gateways: readonly string[], check: PackCheck): string | null {
  try {
    parseAgentConfig(id, text.trim() ? parseToml<RawAgentConfig>(text) : null, {
      defaults: check.defaults,
      knownProviders: check.providers,
      knownGateways: [...gateways],
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Every pack whose `config.toml` names `from`, with its new text — or the refusals, when a pack that loads with the
 * gateways it has now would not load with the renamed ones.
 */
export async function planPackRenames(input: {
  agentsDir: string;
  from: string;
  to: string;
  /** The gateway ids configured now, and after the rename. */
  gateways: { before: readonly string[]; after: readonly string[] };
  check: PackCheck;
}): Promise<{ packs: PackRename[]; refusals: string[] }> {
  const packs: PackRename[] = [];
  const refusals: string[] = [];
  // The directories boot reads as packs: `skills` and `shared` are not, nor anything hidden (`discoverAgents`).
  const ids = listDir(input.agentsDir)
    .filter((entry) => entry.isDirectory && entry.name !== SKILLS_DIR && entry.name !== SHARED_DIR && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  for (const id of ids) {
    const file = join(input.agentsDir, id, "config.toml");
    const text = await readTextFileIfExists(file);
    if (text === null) continue;
    const after = rewriteConfig(text, input.from, input.to);
    if (after === text) continue;
    const loads = packProblem(id, text, input.gateways.before, input.check) === null;
    const problem = packProblem(id, after, input.gateways.after, input.check);
    if (loads && problem) refusals.push(`${id} would not load with the new name: ${problem}`);
    const lines = text
      .split("\n")
      .flatMap((line, index) => (mentionsGateway(line, input.from) ? [{ line: index + 1, text: line.trim() }] : []));
    packs.push({ id, file, lines, after, loads });
  }
  return { packs, refusals };
}
