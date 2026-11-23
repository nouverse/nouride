/**
 * The automation a person was making and never saved, on the list: what it is called, how much of it there is, and the
 * two things to do with it. It is kept in this browser alone (`lib/kept-draft.ts`), which the row says, so it is not
 * looked for on a phone.
 */

import { Link } from "@tanstack/react-router";
import { PencilLine } from "lucide-react";
import { Tag } from "@/commons/components/ui/Tag";
import { keptWords, type KeptDraft } from "../lib/kept-draft";
import { whenWords } from "../lib/runs";

export function UnsavedNew({ kept, onDiscard }: { kept: KeptDraft; onDiscard: () => void }) {
  const { name, holds } = keptWords(kept);
  return (
    <section aria-label="An automation not saved yet" data-unsaved-new className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[22px] border border-dashed border-secondary/40 bg-secondary/[0.05] p-4 sm:px-5">
      <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-secondary/10 text-secondary">
        <PencilLine size={20} />
      </span>
      <div className="min-w-0 flex-[1_1_14rem]">
        <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg leading-snug text-base-content">
          <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
          <Tag tone="needs">Not saved yet</Tag>
        </h2>
        <p className="text-sm text-base-content/65">
          {holds} · left {whenWords(kept.at)} · kept in this browser
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 max-sm:w-full">
        <button type="button" className="btn btn-ghost btn-sm max-sm:flex-1" onClick={onDiscard}>
          Discard
        </button>
        <Link to="/automations/new" className="btn btn-primary btn-sm max-sm:flex-1">
          Continue
        </Link>
      </div>
    </section>
  );
}
