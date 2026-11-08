/**
 * `[memory]`, as a form — every key is install-wide (each in `config.example.toml`).
 *
 * Saved as a patch of what changed, checked by the engine with the loader's own rules, and live: the
 * next turn and the next night read it. An operator's. Who the owner is comes from the welcome step,
 * and is shown on the People tab.
 *
 * One card per thing it decides, every default one that works. The rest sits beside what it shapes:
 * what is learned about people on the People tab, shared knowledge on Shared, how long transcripts
 * are kept on the Timeline.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { MemorySettings } from "@nouride/wire";
import { useSaved } from "@/commons/hooks/use-saved";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { useToast } from "@/commons/components/ui/toast";
import { Details } from "@/commons/components/ui/Details";
import { ModelField } from "./model-field";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";
import { EmbeddingHelp } from "./embedding-help";
import { HelperStatus } from "./helper-status";

type Editable = Omit<MemorySettings, "semantic" | "summaryModel">;
type Semantic = MemorySettings["semantic"];

/** Where semantic search stands, and a way to catch it up — beside the switch it is about. */
function SemanticStatus({ editable }: { editable: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["memory-status"], queryFn: api.memoryStatus, refetchInterval: 15_000 });
  const toast = useToast();
  // Said when refused: without it, Embed now did nothing a person could see (found in 0.8.20).
  const embed = useMutation({
    mutationFn: api.embedMemory,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memory-status"] }),
    onError: (error) => toast.error("Could not embed", error),
  });
  const semantic = status.data?.semantic;
  if (!semantic?.enabled) return null;
  return (
    <div className="ml-12 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-base-content/65">
        {semantic.items} item(s) embedded with {semantic.model}.
        {semantic.ranking
          ? ` Until it has as many as the model before it, ${semantic.ranking.model} (${semantic.ranking.items}), searches are ranked by that one. Its vectors go once this one has every item.`
          : ""}
        {semantic.reachable === false ? " The model isn't responding; search falls back to keywords." : ""}
      </span>
      {editable ? (
        <button type="button" className="btn btn-ghost btn-xs rounded-lg" disabled={embed.isPending || semantic.running} onClick={() => embed.mutate()}>
          {semantic.running ? "Embedding…" : "Embed now"}
        </button>
      ) : null}
    </div>
  );
}

export function SettingsTab({ editable, admin }: { editable: boolean; admin: boolean }) {
  const queryClient = useQueryClient();
  const saved = useSaved();
  const settings = useQuery({ queryKey: ["memory-settings"], queryFn: api.memorySettings });
  // The provider list is an admin's to read; anyone else types the name.
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers, enabled: admin, retry: false });
  const [draft, setDraft] = useState<Partial<Editable>>({});
  const [semanticDraft, setSemanticDraft] = useState<Partial<Semantic>>({});

  useEffect(() => {
    setDraft({});
    setSemanticDraft({});
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => api.setMemorySettings({ ...draft, ...(Object.keys(semanticDraft).length ? { semantic: semanticDraft } : {}) }),
    onSuccess: async (answer) => {
      saved(answer, "Memory settings", "In effect from the next turn.");
      await queryClient.invalidateQueries({ queryKey: ["memory-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-people"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-status"] });
    },
  });

  const current = settings.data;
  if (!current) return settings.error ? <ErrorNote error={settings.error} /> : null;
  const value = <K extends keyof Editable>(key: K): Editable[K] => (key in draft ? (draft[key] as Editable[K]) : current[key]);
  const set = <K extends keyof Editable>(key: K, next: Editable[K]) =>
    setDraft((before) => {
      const copy = { ...before, [key]: next };
      if (JSON.stringify(next) === JSON.stringify(current[key])) delete copy[key];
      return copy;
    });
  const semantic = <K extends keyof Semantic>(key: K): Semantic[K] => (key in semanticDraft ? (semanticDraft[key] as Semantic[K]) : current.semantic[key]);
  const setSemantic = <K extends keyof Semantic>(key: K, next: Semantic[K]) =>
    setSemanticDraft((before) => {
      const copy = { ...before, [key]: next };
      if (next === current.semantic[key]) delete copy[key];
      return copy;
    });
  const dirty = Object.keys(draft).length > 0 || Object.keys(semanticDraft).length > 0;
  // A provider chosen for the pass and no model yet: the engine refuses one without the other.
  const incomplete = Boolean(value("passProvider")) && !value("passModel").trim();
  const profiles = providers.data?.providers.map((p) => p.name) ?? [];
  // Only the OpenAI wire has an embeddings endpoint; an Anthropic profile can never be the embedder.
  const embedders = providers.data?.providers.filter((p) => p.kind === "openai").map((p) => p.name) ?? [];

  return (
    <div className="space-y-4">
      <Card title="Nightly pass" description="Once a night, each finished conversation becomes a summary with tags. What it learns about people is set on the People tab.">
        <div className="space-y-5">
          <div className="space-y-3">
            <ToggleRow label="Run the nightly pass" disabled={!editable} checked={value("pass")} onChange={(next) => set("pass", next)} />
            {value("pass") ? (
              <label className="ml-12 flex items-center gap-2 text-sm">
                <span className="text-base-content/70">At</span>
                <input type="time" className="input input-sm w-32 rounded-xl" disabled={!editable} value={value("passAt")} onChange={(event) => set("passAt", event.target.value)} />
                <span className="text-base-content/65 text-xs">server time</span>
              </label>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field label="Conversations per night" hint="Per agent. Direct conversations go first; the rest wait for the next night.">
              <input type="number" min={1} max={500} className="input input-sm w-24 rounded-xl" disabled={!editable} value={value("passPerNight")} onChange={(event) => set("passPerNight", Number(event.target.value))} />
            </Field>
            <Field label="Tokens per night" /* plain-words-ok: tokens, the unit a model's use is billed in */ hint="All agents together, in and out. The pass stops before the next conversation once they're used; the rest wait. 0 is no limit of its own; today's caps still apply.">
              <input type="number" min={0} step={10000} className="input input-sm w-36 rounded-xl" disabled={!editable} value={value("passMaxTokens")} onChange={(event) => set("passMaxTokens", Number(event.target.value))} />
            </Field>
            <Field label="Attempts per conversation" hint="Before it's left on the Timeline for you to retry. A model that can't be reached doesn't count.">
              <input type="number" min={1} max={10} className="input input-sm w-24 rounded-xl" disabled={!editable} value={value("maxAttempts")} onChange={(event) => set("maxAttempts", Number(event.target.value))} />
            </Field>
          </div>
        </div>
      </Card>

      {/* Its own card: the model is the pass's and compaction's both (`summarizerRoute`), and its trouble is said here. */}
      <Card title="Helper model" description="Runs the nightly pass, and summarizes conversations that get too long for an agent to carry whole.">
        <div className="space-y-3">
          <Field label="Model">
            <select
              className="select select-sm w-full rounded-xl sm:w-1/2"
              disabled={!editable}
              value={value("passProvider") ? "one" : "own"}
              onChange={(event) => {
                const own = event.target.value === "own";
                set("passProvider", own ? "" : (profiles[0] ?? ""));
                set("passModel", "");
              }}
            >
              <option value="own">Each agent's own model</option>
              <option value="one" disabled={profiles.length === 0}>
                One model for every agent
              </option>
            </select>
          </Field>
          {value("passProvider") ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Provider">
                <select className="select select-sm w-full rounded-xl" disabled={!editable} value={value("passProvider")} onChange={(event) => { set("passProvider", event.target.value); set("passModel", ""); }}>
                  {profiles.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model" hint="A small, cheap model is enough.">
                <ModelField provider={value("passProvider")} kind="chat" admin={admin} disabled={!editable} value={value("passModel")} onChange={(next) => set("passModel", next)} />
              </Field>
            </div>
          ) : null}
          {/* A tier (0.8.0) has no provider of its own: it is each agent's model of it, chosen on the Models page. */}
          {!value("passProvider") && value("passModel") ? (
            <p className="text-base-content/65 text-xs">
              Runs on each agent's own <strong>{value("passModel")}</strong>-tier model, set under Model tiers on the Models page.
            </p>
          ) : null}
          {current.summaryModel ? (
            <div className="text-base-content/65 space-y-1 text-xs">
              <p>
                Long conversations are summarized with <b className="font-mono">{current.summaryModel}</b> instead, on each agent's own provider, set by whoever runs the server.
              </p>
              <Details>
                <p>
                  <code className="font-mono">[llm.context] summary_model</code> in config.toml.
                </p>
              </Details>
            </div>
          ) : null}
          <HelperStatus />
        </div>
      </Card>

      <Card title="What agents see">
        <div className="space-y-4">
          <ToggleRow
            label="Put what is remembered into each prompt"
            hint="People's facts, shared knowledge, what is coming up and the latest conversations. Off, the nightly pass still learns and agents still search memory when they need it. A person's own setting on the People tab wins."
            disabled={!editable}
            checked={value("recall")}
            onChange={(next) => set("recall", next)}
          />
          <Field label="Recent conversations in each prompt" hint="Summaries only, never transcripts, and only those the chat may see. 0 leaves them out.">
            <input type="number" min={0} max={20} className="input input-sm w-24 rounded-xl" disabled={!editable} value={value("promptRecent")} onChange={(event) => set("promptRecent", Number(event.target.value))} />
          </Field>
        </div>
      </Card>

      <Card title="Semantic search">
        <div className="space-y-3">
          <ToggleRow
            label="Search by meaning"
            hint="Optional. Finds memories by meaning, not just matching words. Needs an embedding model. It turns on once the model responds."
            disabled={!editable}
            checked={semantic("enabled")}
            onChange={(next) => setSemantic("enabled", next)}
          />
          {semantic("enabled") ? (
            <div className="ml-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Provider (one that embeds)" hint="OpenAI-compatible providers only. A provider that only chats may not offer this; the model is checked before it is switched on.">
                {embedders.length > 0 ? (
                  <select className="select select-sm w-full rounded-xl" disabled={!editable} value={semantic("provider")} onChange={(event) => setSemantic("provider", event.target.value)}>
                    <option value="">Choose a provider</option>
                    {embedders.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="input input-sm w-full rounded-xl" disabled={!editable} placeholder="e.g. ollama" value={semantic("provider")} onChange={(event) => setSemantic("provider", event.target.value)} />
                )}
              </Field>
              <Field label="Embedding model" hint="A model made for embeddings, not a chat model. Checked before it is switched on.">
                <ModelField provider={semantic("provider")} kind="embedding" admin={admin} disabled={!editable} placeholder="e.g. bge-m3 or text-embedding-3-small" value={semantic("model")} onChange={(next) => setSemantic("model", next)} />
              </Field>
              <Field label="Dimensions" hint="Vector size, for models that can shorten theirs. Others keep their own.">
                <input type="number" min={32} max={4096} className="input input-sm w-28 rounded-xl" disabled={!editable} value={semantic("dimensions")} onChange={(event) => setSemantic("dimensions", Number(event.target.value))} />
              </Field>
              <div className="sm:col-span-2">
                <EmbeddingHelp hasEmbedder={embedders.length > 0} />
              </div>
            </div>
          ) : null}
          <SemanticStatus editable={editable} />
        </div>
      </Card>

      {editable ? (
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-primary btn-sm gap-1 rounded-xl" disabled={!dirty || incomplete || save.isPending} onClick={() => save.mutate()}>
            <Save size={14} /> {save.isPending ? "Saving…" : "Save"}
          </button>
          {dirty ? (
            <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={() => { setDraft({}); setSemanticDraft({}); }}>
              Discard
            </button>
          ) : null}
          {incomplete ? <span className="text-base-content/65 text-xs">Pick the helper model to save.</span> : null}
        </div>
      ) : null}
      {save.error ? <ErrorNote error={save.error} /> : null}
    </div>
  );
}
