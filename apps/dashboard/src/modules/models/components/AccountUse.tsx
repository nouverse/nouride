/**
 * How much of a coding-CLI account's plan is used, as its maker or its CLI last said: each limit, the share of it used
 * and when it starts again. Asked on its own once the accounts are listed, so a maker slow to answer holds up nothing.
 * Where each agent on the account signs in by itself, each agent's own, under its name.
 */

import { useQuery } from "@tanstack/react-query";
import type { CliAccountUse } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { ago, inTime } from "@/commons/lib/format";

/** A window's length in words, for a limit with more than one: "5 hours", "weekly", "30 days". */
function lengthWords(minutes: number | null): string {
  if (minutes === null) return "";
  if (minutes === 10_080) return "weekly";
  if (minutes % 1_440 === 0) return `${minutes / 1_440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export function AccountUse({ cli, account, names }: { cli: string; account: string; names: Readonly<Record<string, string>> }) {
  const query = useQuery({ queryKey: ["cli-account-use", cli, account], queryFn: () => api.cliAccountUse(cli, account), staleTime: 5 * 60_000, retry: false });
  if (query.isPending || query.isError) return null;
  if (!query.data.agents) return <UseLines seen={query.data} />;
  return (
    <div className="space-y-2" data-account-use-each>
      {query.data.agents.map((agent) => (
        <div key={agent.id} className="space-y-1">
          <p className="text-xs font-semibold">{names[agent.id] ?? agent.id}'s own sign-in</p>
          <UseLines seen={agent} />
        </div>
      ))}
    </div>
  );
}

function UseLines({ seen }: { seen: Pick<CliAccountUse, "use" | "at" | "said"> }) {
  const { use, at, said } = seen;
  if (!use || use.limits.length === 0) {
    return (
      <p className="text-base-content/65 text-xs" data-account-use>
        How much of its plan is used is not known.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5" data-account-use>
      {use.limits.flatMap((limit) =>
        limit.windows.map((window, index) => (
          <li key={`${limit.id}-${index}`} className="text-xs">
            <span className="flex flex-wrap justify-between gap-x-2">
              <span>{limit.windows.length > 1 && window.minutes !== null ? `${limit.label}, ${lengthWords(window.minutes)}` : limit.label}</span>
              <span className="text-base-content/65">
                {Math.round(window.usedPercent)}% used{window.resetsAt ? `, starts again ${inTime(window.resetsAt)}` : ""}
              </span>
            </span>
            <progress className={`progress h-1.5 w-full ${window.usedPercent >= 90 ? "progress-warning" : "progress-primary"}`} value={window.usedPercent} max={100} />
          </li>
        )),
      )}
      {use.creditsLeft === false ? <li className="text-warning text-xs">No credits left beyond these limits.</li> : null}
      {at ? <li className="text-base-content/65 text-[11px]">{said ? `Said while an agent worked on it, ${ago(at)}.` : `Read ${ago(at)}.`}</li> : null}
    </ul>
  );
}
