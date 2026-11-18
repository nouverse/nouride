/**
 * What decides a mission is done, beside its brief at the top of its page: folded to one line ("10 checks pass, then
 * you accept") until opened, as the brief is. Open, it is the daemon's start notice in full: the commands that must
 * pass, the reviewer, a person's accept. Ten commands open beside a folded brief left a hole under the brief and pushed
 * the result down the page.
 *
 * A check that failed last time opens it by itself: that is the one thing here a person came to read.
 */

import { useState } from "react";
import type { MissionView } from "@nouride/wire";
import { Card } from "@/commons/components/ui/ui";
import { doneWhen } from "../lib/board";

export function DoneWhenCard({ mission }: { mission: MissionView }) {
  const [open, setOpen] = useState(Boolean(mission.lastCheck));
  const said = doneWhen(mission);
  return (
    <Card title="Done when" description={`${said.charAt(0).toUpperCase()}${said.slice(1)}.`} folded={{ open, toggle: () => setOpen((was) => !was) }}>
      <div className="space-y-3 text-sm" data-done-when>
        {mission.checks.length > 0 && (
          <div className="space-y-1">
            <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-base-content/65">Checks that must pass</p>
            <ul className="space-y-1">
              {mission.checks.map((check) => (
                <li key={check} className="rounded-lg bg-base-200/70 px-2.5 py-1 font-mono text-xs break-all">
                  {check}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* A reviewer's brief names paths with no place to break: one ran 140 px out of this card. */}
        <p className="text-base-content/80 [overflow-wrap:anywhere]">
          <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-base-content/65">Reviewer · </span>
          {mission.reviewOn ? (mission.review ?? "checks the result against the goal") : "none"}
        </p>
        {(mission.accept || mission.checks.length === 0) && <p className="text-base-content/80">A person accepts the result before it is done.</p>}
        {mission.lastCheck && (
          <div className="space-y-1">
            <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-error">Last check failed</p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-base-200/70 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">{mission.lastCheck}</pre>
          </div>
        )}
      </div>
    </Card>
  );
}
