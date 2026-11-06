/**
 * Pick who someone is: a person already in `[[people]]`, or a new one by name.
 *
 * Shared by the three places that say it — My Account, Users, and approving a sender — so all three
 * offer the same choice and send the same shape (`{ person }` or `{ name }`).
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/commons/lib/api";
import type { PersonTarget } from "@/commons/lib/api.people";

export function PersonPicker({
  onPick,
  label = "Link",
  busy = false,
  suggestedName = "",
  size = "xs",
}: {
  onPick: (target: PersonTarget) => void;
  label?: string;
  busy?: boolean;
  suggestedName?: string;
  /** `xs` inside a table row; `sm` on a card, beside the card's other controls. */
  size?: "xs" | "sm";
}) {
  const people = useQuery({ queryKey: ["people"], queryFn: api.people });
  const [choice, setChoice] = useState<string>("");
  const [name, setName] = useState(suggestedName);
  const list = people.data?.people ?? [];
  const isNew = choice === "" ? list.length === 0 : choice === "__new";
  const ready = isNew ? name.trim().length > 0 : choice !== "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={size === "sm" ? "select select-sm rounded-xl" : "select select-xs rounded-lg"}
        aria-label="Who this is"
        value={isNew ? "__new" : choice}
        onChange={(event) => setChoice(event.target.value)}
      >
        {list.length > 0 ? <option value="">Choose a person…</option> : null}
        {list.map((person) => (
          <option key={person.key} value={person.key}>
            {person.name} ({person.key}){person.ids?.length ? "" : " (no account yet)"}
          </option>
        ))}
        <option value="__new">A new person…</option>
      </select>
      {isNew ? (
        <input
          className={size === "sm" ? "input input-sm w-44 rounded-xl" : "input input-xs w-36 rounded-lg"}
          placeholder="Their name"
          aria-label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      ) : null}
      <button
        type="button"
        className={size === "sm" ? "btn btn-primary btn-sm rounded-xl" : "btn btn-primary btn-xs rounded-lg"}
        disabled={!ready || busy}
        onClick={() => onPick(isNew ? { name: name.trim() } : { person: choice })}
      >
        {label}
      </button>
    </div>
  );
}
