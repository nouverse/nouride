/**
 * A stdio server's credential variables (0.7.19): `GITHUB_TOKEN`, `APIFY_TOKEN` — each value kept in the secret store
 * and handed to the server's environment when it starts, never written to `config.toml`. A stored one shows as set; its
 * box left blank keeps it.
 */

import { Plus, Trash2 } from "lucide-react";
import type { McpServer } from "@/commons/lib/api";

export interface SecretEnvRow {
  name: string;
  value: string;
  /** A secret is stored for it already: blank keeps it. */
  set: boolean;
}

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The rows a server starts the form with. */
export function secretEnvRows(server?: Pick<McpServer, "envSecrets">): SecretEnvRow[] {
  return (server?.envSecrets ?? []).map((entry) => ({ name: entry.name, value: "", set: entry.set }));
}

/** What is wrong with the rows, said for the person, or null. */
export function secretEnvProblem(rows: readonly SecretEnvRow[]): string | null {
  const names = rows.map((row) => row.name.trim());
  const bad = names.find((name) => !VARIABLE.test(name));
  if (bad !== undefined) return bad ? `"${bad}" is not an environment variable's name` : "A secret variable has no name";
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice) return `${twice} is listed twice`;
  const empty = rows.find((row) => !row.set && !row.value.trim());
  return empty ? `${empty.name.trim()} has no value` : null;
}

/** The rows as the save sends them: the whole set, a value where one was typed, nothing where a stored one is kept. */
export function secretEnvPayload(rows: readonly SecretEnvRow[]): Record<string, { value?: string }> {
  return Object.fromEntries(rows.map((row) => [row.name.trim(), row.value.trim() ? { value: row.value.trim() } : {}]));
}

export function McpSecretEnv({ rows, onChange }: { rows: SecretEnvRow[]; onChange: (rows: SecretEnvRow[]) => void }) {
  const update = (index: number, patch: Partial<SecretEnvRow>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono">Secret variables (optional)</span>
        <button type="button" className="btn btn-ghost btn-xs rounded-lg gap-1" onClick={() => onChange([...rows, { name: "", value: "", set: false }])}>
          <Plus size={13} aria-hidden="true" /> Add variable
        </button>
      </div>
      <p className="text-xs text-base-content/65">
        A key the program reads when it starts, such as GITHUB_TOKEN. Kept safe on this server and handed to the program
        as it starts, never shown again.
      </p>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <input
            className="input input-sm w-48 rounded-xl font-mono text-xs"
            value={row.name}
            placeholder="GITHUB_TOKEN"
            aria-label="Variable name"
            disabled={row.set}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <input
            className="input input-sm min-w-0 flex-1 rounded-xl font-mono text-xs"
            type="password"
            autoComplete="off"
            value={row.value}
            placeholder={row.set ? "Stored. Leave blank to keep" : "Paste the value"}
            aria-label={`Value of ${row.name || "the variable"}`}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg text-error hover:bg-error/10"
            aria-label={`Remove ${row.name || "this variable"}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
