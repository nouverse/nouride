/**
 * What a mission that has started shows of its work, under its brief and its result: its checklist over its turns, and
 * beside them its folder, what decides it is done, the box to tell it something, the questions it asked and, once it
 * ended otherwise than done, why. A draft has none of it (`mission.page.tsx`).
 *
 * From lg two columns. Below it their cards are the grid's own items (`contents`), in the order a phone reads them: how
 * far it is, where it works, what decides it is done, the box to tell it something, then its turns, which run long. "How far is it" was read
 * past every turn on a phone before the Checklist came first.
 */

import { FolderOpen } from "lucide-react";
import type { ChatTurn, LiveTurn, MissionView, NotesPlan } from "@nouride/wire";
import { Mascot } from "@/commons/components/brand/Mascot";
import { FilePath } from "@/commons/components/ui/FilePath";
import { Card } from "@/commons/components/ui/ui";
import { Checklist } from "./Checklist";
import { DoneWhenCard } from "./DoneWhenCard";
import { MissionTimeline } from "./MissionTimeline";
import { Questions } from "./Questions";
import { TellCard } from "./Told";

export function MissionWork({
  mission,
  plan,
  turns,
  live,
  writable,
  pending,
  onTell,
}: {
  mission: MissionView;
  plan: NotesPlan | null;
  turns: ChatTurn[];
  live: LiveTurn | undefined;
  writable: boolean;
  pending: boolean;
  onTell: (text: string, done: () => void) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]" data-work>
      <div className="min-w-0 max-lg:contents max-lg:[&>*]:min-w-0 lg:space-y-5">
        <Card title="Checklist" description="Kept by the agent; every turn starts from it." className="max-lg:order-1">
          <Checklist plan={plan} />
        </Card>
        <Card title="Turns" description="Newest first, each from the mission's page. Open a turn's steps to see what it did." className="min-w-0 max-lg:order-6">
          <MissionTimeline turns={turns} live={live} />
        </Card>
      </div>

      <aside className="min-w-0 max-lg:contents max-lg:[&>*]:min-w-0 lg:space-y-5">
        {/* The folder it works in, over the box to tell it something: for an admin, a way to it in Files. */}
        <p className="flex items-start gap-1.5 rounded-2xl border border-base-content/[0.08] bg-base-100 px-4 py-3 font-mono text-xs text-base-content/70 shadow-soft break-all max-lg:order-2" data-folder>
          <FolderOpen size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <FilePath text={mission.workdir} link="text-primary hover:underline" />
          </span>
        </p>
        <div className="max-lg:order-3">
          <DoneWhenCard mission={mission} />
        </div>
        <div className="max-lg:order-4">
          <TellCard mission={mission} writable={writable} pending={pending} onTell={onTell} />
        </div>
        {mission.answers.length > 0 && (
          <Card title="Questions" className="max-lg:order-5">
            <div className="space-y-3">
              <Questions answers={mission.answers} />
            </div>
          </Card>
        )}
        {mission.seen === "ended" && mission.reason && (
          <Card title="Why it ended" className="max-lg:order-7">
            <p className="flex items-center gap-3 text-sm text-base-content/80 [overflow-wrap:anywhere]">
              <Mascot pose="stuck" decorative className="w-14" />
              <span className="min-w-0">{mission.reason}</span>
            </p>
          </Card>
        )}
      </aside>
    </div>
  );
}
