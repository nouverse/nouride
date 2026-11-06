/**
 * Where the skills that ship with the daemon live.
 *
 * A fourth scope beside `local`, `shared` and `project`, and the only one this repository owns:
 * `skills/` is content we release, updated by upgrading Nouride rather than by editing anything under
 * `.nouride/`. That is the whole reason it is not seeded into `agents/shared/skills/` at setup — a
 * seeded copy becomes the operator's the moment it lands, so a bug in a skill we wrote would live
 * forever on every install, and re-seeding to fix it would clobber whatever they had changed.
 *
 * Read-only in practice rather than by permission: nothing here writes to it, and an operator who
 * wants a built-in skill to behave differently copies it into the shared skill pool, which is read
 * first, so the copy wins (see `dedupeByName` in `loader.ts`).
 *
 * Searched rather than hardcoded, for the same reason `gateways/bridge.ts` searches for the WhatsApp
 * bridge: a checkout and an installed daemon put it in different places, and a relative path that is
 * right for one is silently wrong for the other. Silently is the operative word — the failure is not
 * a crash but an agent that has quietly forgotten how to do something.
 */

import { dirname, join, resolve, statFile } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";

const log = createLogger("agents.builtin-skills");

/**
 * `skills/` beside the executable first — that is what `install.sh` unpacks and what the image has
 * at its working directory — then `content/skills`, which is the checkout layout.
 *
 * **The two differ on purpose.** In the repository these skills sit under `content/` beside
 * `content/agents`, because at that level they are both material a human edits rather than code
 * that runs. An install has no such neighbours to sort: it has a binary, a dashboard and the skills
 * that binary loads, so a `content/` wrapper there would be a directory with one child and no
 * reason. The Dockerfile and the tarball both flatten it (`COPY content/skills ./skills`), which is
 * why the installed name is the short one.
 *
 * `gateways/bridge.ts` carries the same shape for the same reason — bundled beside the executable,
 * source in the tree — so this asymmetry is the house pattern rather than a new one.
 */
export const CANDIDATES = ["skills", "content/skills"];

/**
 * The directory, or `undefined` when there is none.
 *
 * `undefined` rather than a path that does not exist, because the loader treats an absent directory
 * as "no built-in skills" and treats a present one as the source of truth for what is available.
 * Handing it a path to nothing would make every `builtin_disabled` entry look like a typo and warn
 * about it once per agent per reload.
 */
export function resolveBuiltinSkillsDir(): string | undefined {
  for (const root of [process.cwd(), dirname(process.execPath)]) {
    for (const candidate of CANDIDATES) {
      const path = resolve(join(root, candidate));
      if (statFile(path)?.isDirectory === true) return path;
    }
  }

  // Not a warning. A daemon built without them, or an operator who deleted the directory, has said
  // something clear; a line every boot would train people to ignore the log.
  log.debug("no builtin skills directory found", {
    looked: [process.cwd(), dirname(process.execPath)],
  });
  return undefined;
}
