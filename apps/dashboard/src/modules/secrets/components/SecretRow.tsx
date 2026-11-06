/**
 * One secret: its name, where its value comes from, what needs it, and what is said about it (its details, 0.8.19).
 *
 * The dots are not a masking trick. There is no value on this side to mask — the daemon exposes no
 * route that returns one — so what the row shows is the honest shape of what is known: a name that
 * resolves, or does not. Its details are not secret: shown as they are, and changed in place without
 * touching the value.
 */

import { useState } from "react";
import { AlertTriangle, KeyRound, ListPlus, Pencil, Trash2 } from "lucide-react";
import type { FieldChange, SecretEntry } from "@/commons/lib/api.secrets";
import { changeFrom, FieldsEditor, type Row, rowsOf } from "./FieldsEditor";

/** Where the value comes from, in everyday words. */
const ORIGIN: Record<SecretEntry["origin"], { label: string; className: string }> = {
  store: { label: "saved", className: "badge-success" },
  env: { label: "set on the server", className: "badge-info" },
  missing: { label: "not set", className: "badge-error" },
};

/** What needs it, as the daemon names it, in the words the rest of the dashboard uses for those things. Pure. */
export function plainUse(use: string): string {
  return use.replace(/^gateway /, "connection ").replace(/^provider /, "AI provider ").replace(/ \(session encryption\)$/, " (its sign-in)");
}

/** When and by whom it was added, in a few words; nothing when the daemon does not say. */
function addedLine(entry: SecretEntry): string | null {
  if (!entry.addedAt) return null;
  const when = new Date(entry.addedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const who = entry.addedBy?.startsWith("agent:") ? ` by ${entry.addedBy.slice("agent:".length)}` : entry.addedBy ? ` by ${entry.addedBy}` : "";
  return `Added ${when}${who}`;
}

export function SecretRow({
  entry,
  admin,
  busy,
  onReplace,
  onDelete,
  onSaveFields,
}: {
  entry: SecretEntry;
  admin: boolean;
  busy: boolean;
  onReplace: () => void;
  onDelete: () => void;
  onSaveFields: (change: FieldChange) => Promise<boolean>;
}) {
  const origin = ORIGIN[entry.origin];
  // Only a stored value can be removed. An environment variable is the deployment's, and a delete
  // button that cannot do anything is worse than no button.
  const removable = entry.origin === "store" || entry.shadowed;
  const fields = entry.fields ?? {};
  const [editing, setEditing] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);
  const added = addedLine(entry);

  return (
    <div className="rounded-xl border border-base-300/60 bg-base-200/30 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <KeyRound size={15} className="shrink-0 text-base-content/40" aria-hidden="true" />
        <code className="font-mono text-sm">{entry.name}</code>

        {/**
         * Fixed width, not derived from any real length.
         *
         * A row of dots as long as the value would leak the value's length, which for a token is
         * enough to say which provider issued it.
         */}
        <span className="font-mono text-base-content/65 tracking-widest select-none" aria-label="value hidden">
          ••••••••••
        </span>

        <span className={`badge badge-sm ${origin.className} badge-soft`}>{origin.label}</span>

        <div className="ms-auto flex items-center gap-1">
          {entry.origin === "store" ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs rounded-lg gap-1.5"
              disabled={!admin || busy || editing !== null}
              onClick={() => setEditing(rowsOf(fields, Object.keys(fields).length ? [] : ["site", "username"]))}
            >
              <ListPlus size={13} aria-hidden="true" /> Details
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-xs rounded-lg gap-1.5" disabled={!admin || busy} onClick={onReplace}>
            <Pencil size={13} aria-hidden="true" /> Replace
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg gap-1.5 text-error hover:bg-error/10"
            disabled={!admin || busy || !removable}
            title={removable ? undefined : "Set on the server, so it is changed there"}
            onClick={onDelete}
          >
            <Trash2 size={13} aria-hidden="true" /> Delete
          </button>
        </div>
      </div>

      {Object.keys(fields).length > 0 && editing === null ? (
        <ul className="mt-2 flex flex-wrap gap-1.5 ps-7" aria-label={`Details of ${entry.name}`}>
          {Object.entries(fields).map(([name, text]) => (
            <li key={name} className="badge badge-sm badge-ghost max-w-full truncate rounded-md font-mono" title={`${name}: ${text}`}>
              <span className="text-base-content/70">{name}:</span>&nbsp;{text}
            </li>
          ))}
        </ul>
      ) : null}

      {editing !== null ? (
        <div className="mt-3 space-y-2 ps-7">
          <p className="text-xs text-base-content/65">Details are shown to everyone who can see this page, and to your agents. Never put a password in one.</p>
          <FieldsEditor rows={editing} onChange={setEditing} disabled={saving} />
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="btn btn-ghost btn-xs rounded-lg" disabled={saving} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-xs rounded-lg"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                const saved = await onSaveFields(changeFrom(fields, editing));
                setSaving(false);
                if (saved) setEditing(null);
              }}
            >
              Save details
            </button>
          </div>
        </div>
      ) : null}

      {entry.usedBy.length > 0 ? (
        <p className="mt-2 ps-7 text-xs text-base-content/65">Needed by {entry.usedBy.map(plainUse).join(" · ")}</p>
      ) : (
        /**
         * Worth saying. A stored credential nothing references is either a leftover from something
         * that was removed, or a name that does not match the one in the config — and the second is a
         * typo that looks exactly like a working setup until the thing tries to authenticate.
         */
        <p className="mt-2 ps-7 text-xs text-base-content/65">Nothing in your settings uses this name.</p>
      )}
      {added ? <p className="mt-1 ps-7 text-xs text-base-content/65">{added}</p> : null}

      {entry.shadowed ? (
        <p className="mt-2 ps-7 flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            This name is also set on the server itself, and that one is used, not the one saved here. Change it, or remove
            it, where the server is set up.
          </span>
        </p>
      ) : null}
    </div>
  );
}
