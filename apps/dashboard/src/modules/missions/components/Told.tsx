/**
 * Telling a mission something while it works (0.8.10): the box, and what was told so far with whether it read it. The
 * words reach the turn at work before its next step, or wait for its next turn; the agent follows them over the goal's
 * details, and its checks still decide when it is done. Where they went is the toast, in the daemon's own sentence.
 *
 * The box is there while the mission can still be told, for whoever may tell it: one the reader only reads has the
 * list of what it was told and no box.
 */

import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { MissionTold, MissionView } from "@nouride/wire";
import { Card } from "@/commons/components/ui/ui";
import { readsOnly } from "@/commons/lib/by-person";
import { ago } from "@/commons/lib/format";

/** The card that holds both: the box while it works or waits, and what it was told for as long as there is any. */
export function TellCard({ mission, writable, pending, onTell }: { mission: MissionView; writable: boolean; pending: boolean; onTell: (text: string, done: () => void) => void }) {
  const open = !readsOnly(mission) && (mission.seen === "working" || mission.seen === "needs_you");
  if (!open && mission.told.length === 0) return null;
  return (
    <Card title="Tell it" description={open ? "Something it should know while it works." : "What it was told while it worked."}>
      <div className="space-y-4">
        {open && <TellBox disabled={!writable} pending={pending} onTell={onTell} />}
        <ToldList told={mission.told} />
      </div>
    </Card>
  );
}

function TellBox({ onTell, pending, disabled }: { onTell: (text: string, done: () => void) => void; pending: boolean; disabled: boolean }) {
  const [text, setText] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) onTell(text.trim(), () => setText(""));
      }}
    >
      <label className="block">
        <span className="sr-only">What it should know</span>
        <textarea
          className="textarea textarea-sm w-full rounded-xl leading-relaxed"
          rows={3}
          value={text}
          disabled={disabled || pending}
          placeholder="e.g. use the second tab, not the first"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] leading-snug text-base-content/65">Read before its next step, and followed. Its checks still decide when it is done.</p>
        <button type="submit" className="btn btn-primary btn-sm shrink-0 gap-1.5 rounded-xl" disabled={disabled || pending || !text.trim()}>
          {pending ? <span className="loading loading-spinner loading-xs" /> : <MessageSquarePlus size={14} aria-hidden="true" />}
          Tell
        </button>
      </div>
    </form>
  );
}

function ToldList({ told }: { told: MissionTold[] }) {
  if (told.length === 0) return null;
  return (
    <ul className="space-y-2.5">
      {[...told].reverse().map((one) => (
        <li key={one.id} className="space-y-1">
          <p className="ml-auto w-fit max-w-full rounded-2xl rounded-tr-xs bg-secondary/20 px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{one.text}</p>
          <p className="text-right font-mono text-[11px] text-base-content/65">
            {one.via ? `${one.by} via ${one.via}` : one.by} · {ago(one.at)} ·{" "}
            {one.read === undefined ? <span className="text-warning">not read yet</span> : <span>read in turn {one.read}</span>}
          </p>
        </li>
      ))}
    </ul>
  );
}
