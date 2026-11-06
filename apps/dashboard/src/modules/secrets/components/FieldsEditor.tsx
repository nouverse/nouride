/**
 * What is said about a secret (0.8.19): rows of a name and a text, added, changed and removed in place, then saved at
 * once. The names are free; the common ones are offered as the person types. Nothing here is secret, so it is plain
 * text, and the daemon refuses a text that looks like a key or a password, naming the field.
 */

import { useId, useState } from "react";
import { Plus, X } from "lucide-react";

/** Offered as a name is typed, in everyday words; any other name is as good. */
const SUGGESTED = ["site", "username", "email", "used for"] as const;

export interface Row {
  name: string;
  text: string;
}

/** The rows as a change against what was saved: what to set (non-empty texts) and what to remove. Pure. */
export function changeFrom(saved: Readonly<Record<string, string>>, rows: readonly Row[]): { set: Record<string, string>; remove: string[] } {
  const set: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const text = row.text.trim();
    if (name && text && saved[name] !== text) set[name] = text;
  }
  const kept = new Set(rows.filter((row) => row.name.trim() && row.text.trim()).map((row) => row.name.trim()));
  return { set, remove: Object.keys(saved).filter((name) => !kept.has(name)) };
}

export function rowsOf(fields: Readonly<Record<string, string>>, blank: readonly string[] = []): Row[] {
  const rows = Object.entries(fields).map(([name, text]) => ({ name, text }));
  for (const name of blank) if (!(name in fields)) rows.push({ name, text: "" });
  return rows;
}

export function FieldsEditor({ rows, onChange, disabled }: { rows: Row[]; onChange: (rows: Row[]) => void; disabled?: boolean }) {
  const list = useId();
  const [focus, setFocus] = useState<number | null>(null);
  const set = (index: number, row: Partial<Row>) => onChange(rows.map((current, i) => (i === index ? { ...current, ...row } : current)));
  return (
    <div className="space-y-2">
      <datalist id={list}>
        {SUGGESTED.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            className="input input-sm w-32 shrink-0 rounded-lg text-sm sm:w-40"
            aria-label="Detail name"
            placeholder="site"
            list={list}
            value={row.name}
            disabled={disabled}
            autoFocus={focus === index}
            onChange={(event) => set(index, { name: event.target.value })}
          />
          <input
            className="input input-sm min-w-0 flex-1 rounded-lg text-sm"
            aria-label={row.name ? `${row.name}` : "Detail"}
            placeholder={row.name === "site" ? "github.com" : row.name === "username" ? "the account it signs in as" : ""}
            value={row.text}
            disabled={disabled}
            onChange={(event) => set(index, { text: event.target.value })}
          />
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square rounded-lg"
            aria-label={`Remove ${row.name || "this detail"}`}
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-xs rounded-lg gap-1.5"
        disabled={disabled}
        onClick={() => {
          setFocus(rows.length);
          onChange([...rows, { name: "", text: "" }]);
        }}
      >
        <Plus size={13} aria-hidden="true" /> Add a detail
      </button>
    </div>
  );
}
