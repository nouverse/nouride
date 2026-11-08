/**
 * A coding CLI's standing beside its name (0.8.24): a badge and a sentence (`standingWords`), its version numbers under
 * Details with the package they are of. The version is the one Nouride starts and reads, its connector's, which is not
 * the number the CLI itself shows: kept out of the sentence for that reason.
 */

import type { CliVersionView } from "@/commons/lib/api.external-agents";
import { standingWords } from "@/commons/lib/cli-standing";
import { updateMessage } from "@/commons/lib/set-up";
import { AskAgentButton } from "./AskAgentButton";
import { Details } from "./Details";

const TONE = { success: "badge-success", info: "badge-info", warning: "badge-warning" } as const;

interface Props {
  name: string;
  /** Its id, for the update the button asks for; none where the page offers no update. */
  cli?: string;
  pkg?: string | undefined;
  version?: string | undefined;
  standing?: CliVersionView | undefined;
  /** Where the page has a Details of its own beside it, its numbers go there (`CliVersionNumbers`): two read as one too many. */
  ownDetails?: boolean;
}

/** The version numbers, for whoever runs the server: the package they are of, what an update installs, what is out. */
export function CliVersionNumbers({ pkg, version, standing }: Pick<Props, "pkg" | "version" | "standing">) {
  if (!standing) return null;
  return (
    <p className="font-mono">
      {version ? `${pkg ?? "version"} ${version}` : null}
      {standing.offer ? ` · an update installs ${standing.offer}` : null}
      {standing.untested ? ` · ${standing.untested} is out, not tested with this Nouride yet` : null}
    </p>
  );
}

export function CliStanding({ name, cli, pkg, version, standing, ownDetails = true }: Props) {
  if (!standing) return null;
  const words = standingWords(name, standing);
  return (
    <div className="space-y-1" data-standing={standing.standing}>
      <p className="flex flex-wrap items-center gap-2 text-xs text-base-content/75">
        <span className={`badge badge-sm badge-soft shrink-0 font-mono ${TONE[words.tone]}`}>{words.badge}</span>{" "}
        <span>{words.says}</span>
      </p>
      {words.update && cli ? <AskAgentButton task="to update it" message={updateMessage(name, cli)} /> : null}
      {ownDetails ? (
        <Details>
          <CliVersionNumbers pkg={pkg} version={version} standing={standing} />
        </Details>
      ) : null}
    </div>
  );
}
