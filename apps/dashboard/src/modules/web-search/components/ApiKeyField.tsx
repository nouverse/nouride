/**
 * Where the search key comes from: pasted here, or a secret that already holds it.
 *
 * A pasted key is never kept by the page or written to the config. On save it goes to the secret
 * store under the name below, and only that name is written to `config.toml` — the same rule as every
 * other credential in the dashboard. The name is editable but rarely needs to be, so it sits behind
 * the key rather than in front of it.
 */

import { CheckCircle2, CircleAlert, KeyRound } from "lucide-react";
import type { SecretEntry } from "@nouride/wire";
import { Combobox } from "@/commons/components/ui/Combobox";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { Field } from "@/commons/components/ui/ui";

export type KeySource = "paste" | "secret";

export function ApiKeyField({
  source,
  onSource,
  value,
  onValue,
  secretName,
  onSecretName,
  secrets,
  loadingSecrets,
  optional,
  disabled,
  exampleName,
}: {
  source: KeySource;
  onSource: (next: KeySource) => void;
  value: string;
  onValue: (next: string) => void;
  secretName: string;
  onSecretName: (next: string) => void;
  secrets: SecretEntry[];
  loadingSecrets?: boolean;
  /** A custom endpoint may authenticate upstream and need no key at all. */
  optional?: boolean;
  disabled?: boolean;
  /** The secret's usual name for this service, shown in an empty name field. */
  exampleName: string;
}) {
  const stored = secrets.filter((entry) => entry.origin !== "missing");
  const picked = secrets.find((entry) => entry.name === secretName.trim());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-base-content/85 font-mono">
          <KeyRound size={14} /> API key{optional ? <span className="font-normal normal-case tracking-normal text-base-content/65">(optional)</span> : null}
        </span>
        <SegmentedTabs
          tabs={[
            { value: "paste", label: "Paste a key" },
            { value: "secret", label: "Use a saved secret", after: stored.length ? <span className="text-base-content/65">{stored.length}</span> : undefined },
          ]}
          value={source}
          onChange={onSource}
        />
      </div>

      {source === "paste" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_minmax(0,14rem)]">
          <Field label="Key" hint="Saved to Secrets when you save. It is never shown again, here or anywhere.">
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              className="input w-full rounded-xl font-mono text-sm"
              placeholder={optional ? "Leave it empty if the service needs none" : "Paste your API key"}
              value={value}
              disabled={disabled}
              onChange={(event) => onValue(event.target.value)}
            />
          </Field>
          <Field label="Save as" hint="The secret's name.">
            <input
              className="input w-full rounded-xl font-mono text-sm"
              value={secretName}
              disabled={disabled}
              onChange={(event) => onSecretName(event.target.value)}
            />
          </Field>
        </div>
      ) : (
        <Field
          label="Secret"
          hint={stored.length ? "Pick one from Secrets, or type the name of one set in the environment." : "Nothing is stored yet. Paste a key instead, or add one on the Secrets page."}
        >
          <Combobox
            options={stored.map((entry) => entry.name)}
            value={secretName}
            onChange={onSecretName}
            loading={loadingSecrets}
            disabled={disabled}
            placeholder={exampleName}
            customHint="use this name"
            listOnFocus
          />
        </Field>
      )}

      {source === "secret" && secretName.trim() ? (
        picked && picked.origin !== "missing" ? (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 size={13} /> Set {picked.origin === "env" ? "in the environment" : "in Secrets"}
            {picked.usedBy.length ? <span className="text-base-content/65">· also used by {picked.usedBy.join(", ")}</span> : null}
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <CircleAlert size={13} /> No value is set under this name yet.
          </p>
        )
      ) : null}
    </div>
  );
}
