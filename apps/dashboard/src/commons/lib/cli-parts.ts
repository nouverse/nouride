/**
 * What a coding CLI runs on, in the words a person reads: the CLI's own version on its badge, what carries and
 * runs it in a line under that, a warning where the runtime is too old, and the rest for Details. The daemon reads the
 * parts from the files installed; this says them.
 *
 * The badge read "installed" and no version at all, because the one version read was the connector's: a person asking
 * which Claude Code this is had no page that said.
 */

import type { CliPart } from "@nouride/wire";

export interface PartsWords {
  /** The CLI itself with its version, on the badge: "Claude Code 2.1.323". Null where its version was not read. */
  own: string | null;
  /** What carries it and what runs that, a sentence under the badge. Null where neither was read. */
  inside: string | null;
  /** A warning where the runtime is under what the connector asks for; null otherwise. */
  tooOld: string | null;
  /** The connector's other dependencies as installed, each "name version", for Details. */
  rest: string[];
}

/** A package's name without its scope, as a person says it. */
const unscoped = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

const withVersion = (name: string, version: string | undefined): string => `${name} ${version ?? "(version not read)"}`;

export function partsWords(parts: readonly CliPart[] | undefined): PartsWords {
  const all = parts ?? [];
  const own = all.find((part) => part.kind === "cli");
  const connector = all.find((part) => part.kind === "connector");
  const runtime = all.find((part) => part.kind === "runtime");
  const carried = connector ? withVersion(unscoped(connector.name), connector.version) : null;
  const run = runtime ? withVersion(runtime.name, runtime.version) : null;
  return {
    own: own?.version ? `${own.name} ${own.version}` : null,
    inside: carried && run ? `Runs in ${carried}, on ${run}.` : carried ? `Runs in ${carried}.` : null,
    tooOld:
      runtime?.tooOld && runtime.needs
        ? `${withVersion(runtime.name, runtime.version)} is too old for ${connector ? unscoped(connector.name) : "it"}, which needs ${runtime.needs.replace(/^\s*>=\s*v?/, "")} or newer. Whoever runs this server needs to update ${runtime.name}.`
        : null,
    rest: all.filter((part) => part.kind === "dependency").map((part) => withVersion(part.name, part.version)),
  };
}
