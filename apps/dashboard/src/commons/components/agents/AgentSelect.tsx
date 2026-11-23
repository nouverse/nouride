/**
 * Picking an agent from a list: each with its face, and a field to type its name into. The automation page offered
 * agents as a plain list of names, where every other place an agent is picked shows whose face it is, and seven names
 * are read one by one where two letters find one.
 *
 * The answer is always an agent of the list (`SearchSelect`): what is typed narrows the list and is no answer itself.
 */

import type { Look } from "@/commons/cat/look";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { AgentAvatar } from "./AgentAvatar";

export interface AgentPick<V extends string = string> {
  value: V;
  name: string;
  /** Absent for an agent the daemon no longer has: its name's first letter stands in. */
  look?: Look | undefined;
  /** Its row's words where they say more than its name: "Nouva, who runs this automation". */
  words?: string;
}

/** An agent's face at a row's size, or its initial where there is no face to draw. */
function Face({ pick }: { pick: AgentPick }) {
  // Beside its name, which says who it is: the picture adds no words of its own.
  if (pick.look) {
    return (
      <span aria-hidden="true" className="shrink-0">
        <AgentAvatar look={pick.look} name={pick.name} size="xxs" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-[8px] bg-base-content/[0.07] text-xs font-bold text-base-content/65">
      {pick.name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function AgentSelect<V extends string>({
  label,
  picks,
  value,
  onChange,
  disabled = false,
  placeholder = "",
  className,
}: {
  /** What is being picked, as the button and the list are named. */
  label: string;
  picks: readonly AgentPick<V>[];
  value: V;
  onChange: (next: V) => void;
  disabled?: boolean;
  /** The button's words while `value` is none of the picks. */
  placeholder?: string;
  className?: string;
}) {
  return (
    <SearchSelect
      label={label}
      searchLabel="Find an agent"
      noMatch={(typed) => `No agent called “${typed}”`}
      align="start"
      className={className ?? "w-full"}
      disabled={disabled}
      options={picks.map((pick) => ({ value: pick.value, label: pick.words ?? pick.name, lead: <Face pick={pick} /> }))}
      value={value}
      placeholder={placeholder}
      onChange={onChange}
    />
  );
}
