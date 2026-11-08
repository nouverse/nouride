/**
 * The form that adds or edits one server of the install's MCP library — by hand, or filled in from the catalog
 * (`McpExplore`) — and, while adding, which agents to switch it on for.
 */

import { AgentName, useOrchestrator, useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CatalogDraft, type McpLibraryServer, type McpServer } from "@/commons/lib/api";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";
import { McpSecretEnv, secretEnvPayload, secretEnvProblem, secretEnvRows, type SecretEnvRow } from "./McpSecretEnv";

/**
 * A remote server from the catalog that asks for no key: the registry lists the headers a server needs, and one that
 * lists none either needs nothing or signs in with an account (OAuth) — Notion, Linear — which its card offers once it
 * asks. The form says so instead of offering an empty key box.
 */
export function asksNoKey(draft: Pick<CatalogDraft, "runsVia" | "token" | "headers"> | undefined): boolean {
  return Boolean(draft && draft.runsVia === "remote" && !draft.token && !Object.keys(draft.headers ?? {}).length);
}

/** What still has to change before a catalog server can work: a `{slug}` in its URL, a `<value>` in its arguments. */
export function draftBlocker(input: { url?: string; args?: string; local: boolean }): string | null {
  if (!input.local && input.url && /\{[^}]+\}/.test(input.url)) return "Replace the {…} in the URL first.";
  if (input.local && input.args && /<[^>\s]+>/.test(input.args)) return "Fill in the <…> in the arguments first.";
  return null;
}

export function McpServerForm({
  existing,
  draft,
  agents = [],
  enable: enableFirst = [],
  onClose,
  onSaved,
}: {
  existing?: McpLibraryServer;
  /** What the catalog says to fill in, for a server being added from it (Explore). */
  draft?: CatalogDraft;
  /** Every agent, to pick which use a server being added. */
  agents?: readonly string[];
  /** Those picked to begin with — the agent whose `mcp_search` link this is. */
  enable?: readonly string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const orchestrator = useOrchestrator();
  const pickable = useOrchestratorFirst(agents, (id) => id);
  const start = existing ?? draft;
  const signsIn = asksNoKey(draft);
  const [useToken, setUseToken] = useState(false);
  const [name, setName] = useState(start?.name ?? "");
  const [transport, setTransport] = useState<McpServer["transport"]>(start?.transport ?? "stdio");
  const [command, setCommand] = useState(start?.command ?? "");
  const [args, setArgs] = useState((start?.args ?? []).join("\n"));
  const [cwd, setCwd] = useState(existing?.cwd ?? "");
  const [url, setUrl] = useState(start?.url ?? "");
  const [authHeader, setAuthHeader] = useState(existing?.authHeader ?? draft?.token?.header ?? "");
  // A catalog server's plain variables that have no value yet: the person gives them.
  const [envInputs, setEnvInputs] = useState<Record<string, string>>(Object.fromEntries((draft?.envInputs ?? []).map((input) => [input.name, ""])));
  // Never pre-filled from the server, which does not send it. Blank on an edit means "keep it".
  const [token, setToken] = useState("");
  const [enable, setEnable] = useState<string[]>([...enableFirst]);
  const [perAgent, setPerAgent] = useState(existing?.perAgent ?? false);
  const [secretEnv, setSecretEnv] = useState<SecretEnvRow[]>(
    existing ? secretEnvRows(existing) : (draft?.secretEnv ?? []).map((input) => ({ name: input.name, value: "", set: false })),
  );

  const local = transport === "stdio";
  const envProblem = local ? secretEnvProblem(secretEnv) : null;
  const missingInput = (draft?.envInputs ?? []).find((input) => input.required && !envInputs[input.name]?.trim());
  const blocker = draft ? (draftBlocker({ url, args, local }) ?? (missingInput ? `${missingInput.name} needs a value.` : null)) : null;

  const saved = useSaved();
  const save = useMutation({
    mutationFn: () =>
      api.saveLibraryServer({
        name: name.trim(),
        transport,
        perAgent,
        ...(existing ? {} : { enable }),
        ...(local
          ? {
              command: command.trim(),
              args: args
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
              ...(draft && (Object.keys(draft.env ?? {}).length || Object.keys(envInputs).length)
                ? { env: { ...draft.env, ...Object.fromEntries(Object.entries(envInputs).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()])) } }
                : {}),
              // The whole set, so one taken off here is taken off the server.
              ...(secretEnv.length || existing?.envSecrets?.length ? { envSecrets: secretEnvPayload(secretEnv) } : {}),
            }
          : {
              url: url.trim(),
              ...(draft?.headers && Object.keys(draft.headers).length ? { headers: draft.headers } : {}),
              ...(authHeader.trim() ? { authHeader: authHeader.trim() } : {}),
              ...(token.trim() ? { token: token.trim() } : {}),
            }),
      }),
    onSuccess: (answer) => {
      saved(answer, existing ? name.trim() : `${name.trim()} in the library`, enable.length > 0 && !existing ? `Connecting for ${enable.join(", ")} now. Its tools arrive with their next turn.` : "Switch it on for an agent below.");
      onSaved();
    },
  });

  const body = (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" hint="Its tools are named after it (github, say).">
          <input
            className="input w-full rounded-xl text-sm"
            value={name}
            disabled={Boolean(existing)}
            placeholder="github"
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="How It Runs" hint="On this server, or reached over the internet.">
          <select
            className="select w-full rounded-xl text-sm"
            value={transport}
            onChange={(e) => setTransport(e.target.value as McpServer["transport"])}
          >
            <option value="stdio">On this server: a program Nouride starts</option>
            <option value="streamable-http">Over the internet</option>
            <option value="sse">Over the internet, the older way</option>
          </select>
        </Field>
      </div>

      {local ? (
        <>
          <Field label="Program" hint="The program to start, by its name or its full path.">
            <input
              className="input w-full font-mono text-sm rounded-xl"
              value={command}
              placeholder="python3 / npx"
              onChange={(e) => setCommand(e.target.value)}
              required
            />
          </Field>

          <Field label="What to Start It With (One per Line)" hint="Handed to the program exactly as written.">
            <textarea
              className="textarea min-h-24 w-full font-mono text-xs rounded-xl leading-relaxed"
              value={args}
              placeholder={"/path/to/server.py\n--transport\nstdio"} // plain-words-ok: an example of what this field takes
              onChange={(e) => setArgs(e.target.value)}
            />
          </Field>

          <Field
            label="Folder to Start In (optional)"
            hint="Where the program starts, for paths written short."
          >
            <input
              className="input w-full font-mono text-sm rounded-xl"
              value={cwd}
              placeholder="/opt/my-mcp-server" // plain-words-ok: an example of what this field takes
              onChange={(e) => setCwd(e.target.value)}
            />
          </Field>

          {(draft?.envInputs ?? []).map((input) => (
            <Field key={input.name} label={`${input.name}${input.required ? "" : " (optional)"}`} {...(input.description ? { hint: input.description } : {})}>
              <input
                className="input w-full font-mono text-sm rounded-xl"
                value={envInputs[input.name] ?? ""}
                onChange={(e) => setEnvInputs({ ...envInputs, [input.name]: e.target.value })}
              />
            </Field>
          ))}

          <McpSecretEnv rows={secretEnv} onChange={setSecretEnv} />
        </>
      ) : (
        <>
          <Field label="Address" hint="Its web address, http or https.">
            <input
              className="input w-full font-mono text-sm rounded-xl"
              value={url}
              type="url"
              placeholder="https://mcp.example.com/mcp" // plain-words-ok: an example of what this field takes
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </Field>

          {signsIn && !useToken ? (
            <div className="rounded-xl border border-info/25 bg-info/5 p-3 text-sm text-base-content/80 space-y-1">
              <p>
                <span className="font-semibold text-base-content">No key needed: the catalog lists none for it.</span> Add it; if it asks
                you to sign in with an account (as Notion does), its card says <span className="font-semibold">needs login</span>; press{" "}
                <span className="font-semibold">Connect</span> there.{" "}
                {perAgent ? "Each agent signs in on its own." : "One sign-in serves every agent it is switched on for."}
              </p>
              <button type="button" className="link link-hover text-xs text-base-content/65" onClick={() => setUseToken(true)}>
                Use a key instead
              </button>
            </div>
          ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={existing?.hasCredential ? "Replace the Key" : draft?.token ? `${draft.token.name}${draft.token.required ? "" : " (optional)"}` : "Key (optional)"}
              hint={
                existing?.hasCredential
                  ? "A key is saved. Leave it empty to keep it."
                  : `${draft?.token?.description ? `${draft.token.description} ` : ""}Kept safe on this server, never shown again.`
              }
            >
              <input
                className="input w-full font-mono text-sm rounded-xl"
                value={token}
                type="password"
                autoComplete="off"
                placeholder={existing?.hasCredential ? "••••••••" : "Paste the key"}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>

            <Field
              label="Key Header (optional)"
              hint="Empty sends it the usual way. Set it only when the service asks for the key under another name."
            >
              <input
                className="input w-full font-mono text-sm rounded-xl"
                value={authHeader}
                placeholder="X-Api-Key"
                onChange={(e) => setAuthHeader(e.target.value)}
              />
            </Field>
          </div>
          )}
        </>
      )}

      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={perAgent} onChange={(e) => setPerAgent(e.target.checked)} />
        <span className="text-sm">
          <span className="font-medium">Each agent brings its own key</span>
          <span className="block text-base-content/65">For an account that is one person's: no agent uses the key above, each gives its own or logs in itself.</span>
        </span>
      </label>

      {!existing && agents.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 font-mono">Switch it on for</p>
          <div className="flex flex-wrap gap-2">
            {pickable.map((id) => {
              const on = enable.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  className={`btn btn-xs rounded-lg font-mono gap-1 ${on ? "btn-primary" : "btn-ghost border border-base-content/15"}`}
                  onClick={() => setEnable(on ? enable.filter((other) => other !== id) : [...enable, id])}
                >
                  <AgentName id={id} orchestrator={orchestrator} size={10} />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {draft?.notes.length ? (
        <div role="note" className="alert alert-warning bg-warning/10 border border-warning/30 text-warning rounded-xl p-3 text-xs">
          <ul className="list-disc pl-4 space-y-0.5">
            {draft.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {envProblem && secretEnv.length > 0 ? <p className="text-xs text-warning">{envProblem}</p> : null}
      {blocker ? <p className="text-xs text-warning">{blocker}</p> : null}
      <ErrorNote error={save.error} />

      <div className="flex items-center gap-2 pt-2">
        <button
          type="submit"
          className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
          disabled={save.isPending || Boolean(envProblem) || Boolean(blocker)}
        >
          {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
          {existing ? "Save Changes" : "Add Connector"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );

  if (existing) return body;
  return (
    <Card
      title={draft ? `Add ${draft.title ?? draft.name}` : "Add a Connector"}
      {...(draft?.source ? { description: `From the public catalog: ${draft.source}` } : {})}
      className="border-primary/30 shadow-lg"
    >
      {body}
    </Card>
  );
}
