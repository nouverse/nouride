/**
 * What every call of the reflection pass is given, whoever asked for it: the provider, the transcript, and the pool as
 * triage reads it, each skill with who keeps it and how big it is. Out of `index.ts`, which decides when a pass runs.
 */

import type { LLMProvider } from "@nouride/shared";
import type { DraftsPort } from "./drafts.store.ts";
import { breadthOf, listSkillFiles, readPool, readSkill, readSkillFile } from "./pool.ts";
import type { SynthesisInput } from "./synthesis.ts";
import type { Trigger } from "./types.ts";

/** What every call of the pass is given, whoever asked for it: the provider, the transcript and the pool as triage reads it. */
export async function passInput(
  drafts: DraftsPort,
  made: { provider: LLMProvider; model: string; triageModel: string; transcript: string; existing: Awaited<ReturnType<typeof readPool>>; inPlay: string[] },
  trigger: Trigger,
): Promise<SynthesisInput> {
  return {
    provider: made.provider,
    model: made.model,
    transcript: made.transcript,
    trigger,
    existing: await Promise.all(
      made.existing.map(async (skill) => ({
        name: skill.name,
        description: skill.description,
        /**
         * Listed whatever it is, marked by who keeps it — see `renderSkillList`.
         *
         * A skill the pass may not write to still has to appear, or it cannot be recognised as
         * covering the ground and declined as a duplicate. `author` is set by this loop when it
         * writes one, so its absence in the shared pool means a person wrote the file by hand;
         * `builtin` is ours and is absent from `author` for a different reason. See `Skill.author`.
         */
        owner: skill.scope === "builtin" ? "nouride" : skill.author ? "agent" : "person",
        ...(await breadthOf(skill)),
      })),
    ),
    readSkill: (name) => readSkill(made.existing, name, drafts),
    listSkillFiles: (name) => listSkillFiles(made.existing, name),
    readSkillFile: (name, path) => readSkillFile(made.existing, name, path),
    triageModel: made.triageModel,
    inPlay: made.inPlay,
  };
}
