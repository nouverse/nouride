/**
 * What a coding CLI runs on, beside its name: its own version on the badge, what carries and runs it under
 * that, a warning where the runtime is too old (`partsWords`). The badge said "installed" and no version: the one
 * version Nouride read was the connector's, which is not the number the CLI shows.
 */

import type { CliPart } from "@nouride/wire";
import { partsWords } from "@/commons/lib/cli-parts";

/** The CLI's own version, where it was read; "installed" where it was not. */
export function CliOwnBadge({ parts }: { parts?: readonly CliPart[] | undefined }) {
  const words = partsWords(parts);
  return (
    <span className="badge badge-sm badge-ghost font-mono" data-cli-own={words.own ? "version" : "installed"}>
      {words.own ?? "installed"}
    </span>
  );
}

/** What carries it and what runs that, and the warning where the runtime is too old. Nothing where neither was read. */
export function CliPartsLine({ parts }: { parts?: readonly CliPart[] | undefined }) {
  const words = partsWords(parts);
  if (!words.inside && !words.tooOld) return null;
  return (
    <div className="space-y-1 text-xs">
      {words.inside ? <p className="text-base-content/65">{words.inside}</p> : null}
      {words.tooOld ? <p className="text-warning">{words.tooOld}</p> : null}
    </div>
  );
}

/** The connector's other dependencies as installed, for a Details section. */
export function CliPartsRest({ parts }: { parts?: readonly CliPart[] | undefined }) {
  const { rest } = partsWords(parts);
  if (rest.length === 0) return null;
  return <p className="font-mono">with {rest.join(" · ")}</p>;
}
