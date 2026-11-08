/**
 * Adding a credential, and replacing one — the same form, because they are the same request.
 *
 * The store has no separate update: writing a name that exists overwrites it. That is deliberate on
 * the daemon's side, so a rotated key goes in without a delete-then-add window where nothing
 * resolves — and it means this form only has to know whether the name is already decided.
 */

import { useState } from "react";
import { KeyRound } from "lucide-react";
import type { FieldChange } from "@nouride/wire";
import { Card, Field } from "@/commons/components/ui/ui";
import { changeFrom, FieldsEditor, type Row, rowsOf } from "./FieldsEditor";

/**
 * The same rule the config parser applies.
 *
 * Checked here as well as on the daemon, and not because the daemon's check is in doubt: a name is
 * refused for a reason worth reading *before* you paste a credential into the next field, and a
 * round trip to find that out is one more place the value has been.
 */
const VALID_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

export function SecretForm({
  name,
  pending,
  onCancel,
  onSubmit,
}: {
  /** Empty to add; a name to replace that one, which then cannot be edited. */
  name: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (name: string, value: string, fields?: FieldChange) => void;
}) {
  const replacing = name !== "";
  const [draft, setDraft] = useState(name);
  const [value, setValue] = useState("");
  // A new secret is asked what it is (0.8.19): its site and account offered first, any other detail as needed.
  const [rows, setRows] = useState<Row[]>(() => rowsOf({}, ["site", "username"]));

  const trimmed = draft.trim();
  const nameProblem =
    replacing || trimmed === "" ? null : VALID_NAME.test(trimmed)
      ? null
      : "Letters, digits, dashes and underscores; 63 characters at most.";
  const ready = trimmed !== "" && value !== "" && !nameProblem && !pending;

  return (
    <Card
      title={replacing ? `Replace ${name}` : "Add a secret"}
      description={
        replacing
          ? "The new value is used from now on. Connections already running keep the old one until they reconnect. Its details stay as they are."
          : "Give it the name your settings use, then the value. The value is saved locked and is never shown again."
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          const fields = replacing ? undefined : changeFrom({}, rows);
          onSubmit(trimmed, value, fields && Object.keys(fields.set).length ? { set: fields.set } : undefined);
        }}
      >
        <Field
          label="Name"
          hint={replacing ? "Replacing keeps this name." : "The name your settings use for it, like discord_nox_token."} // plain-words-ok: an example of the name this field takes
        >
          <input
            className="input w-full rounded-xl font-mono text-sm"
            value={draft}
            readOnly={replacing}
            disabled={replacing}
            autoFocus={!replacing}
            placeholder="discord_nox_token" // plain-words-ok: an example of what this field takes
            onChange={(event) => setDraft(event.target.value)}
          />
        </Field>
        {nameProblem ? <p className="text-xs text-error -mt-2">{nameProblem}</p> : null}

        <Field label="Value" hint="Saved locked. It can be replaced, never shown, not even to you.">
          {/**
           * `type="password"`, which here is not about hiding it from the person typing it — they
           * have it on their clipboard. It keeps the value out of a screen share, out of a
           * screenshot, and out of the browser's own autofill history for a normal text field.
           */}
          <input
            type="password"
            className="input w-full rounded-xl font-mono text-sm"
            value={value}
            autoFocus={replacing}
            autoComplete="new-password"
            spellCheck={false}
            placeholder="paste the password or key"
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>

        {replacing ? null : (
          <Field label="Details (optional)" hint="What it is: its site, the account it signs in as, what it is used for. Shown to your agents too, so never a password.">
            <FieldsEditor rows={rows} onChange={setRows} disabled={pending} />
          </Field>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary btn-sm rounded-xl gap-2 shadow-xs active:scale-95 transition-all"
            disabled={!ready}
          >
            <KeyRound size={15} /> {replacing ? "Replace" : "Save"}
          </button>
        </div>
      </form>
    </Card>
  );
}
