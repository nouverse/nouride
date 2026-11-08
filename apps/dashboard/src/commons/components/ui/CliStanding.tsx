/**
 * A coding CLI's standing beside its name (0.8.24): a badge and a sentence (`standingWords`), its version numbers under
 * Details with the package they are of. The version is the one Nouride starts and reads, its connector's, which is not
 * the number the CLI itself shows: kept out of the sentence for that reason.
 */

import type { CliVersionView } from "@/commons/lib/api.external-agents";
import { standingWords } from "@/commons/lib/cli-standing";
import { Details } from "./Details";

const TONE = { success: "badge-success", info: "badge-info", warning: "badge-warning" } as const;

export function CliStanding({ name, pkg, version, standing }: { name: string; pkg?: string | undefined; version?: string | undefined; standing?: CliVersionView | undefined }) {
  if (!standing) return null;
  const words = standingWords(name, standing);
  return (
    <div className="space-y-1" data-standing={standing.standing}>
      <p className="flex flex-wrap items-center gap-2 text-xs text-base-content/75">
        <span className={`badge badge-sm badge-soft shrink-0 font-mono ${TONE[words.tone]}`}>{words.badge}</span>{" "}
        <span>{words.says}</span>
      </p>
      <Details>
        <p className="font-mono">
          {version ? `${pkg ?? "version"} ${version}` : null}
          {standing.offer ? ` · an update installs ${standing.offer}` : null}
          {standing.untested ? ` · ${standing.untested} is out, not tested with this Nouride yet` : null}
        </p>
      </Details>
    </div>
  );
}
