import { useMutation, useQuery } from "@tanstack/react-query";
import { HeadlineField } from "@/commons/components/ui/HeadlineField";
import { useEffect, useRef, useState } from "react";
import { api } from "@/commons/lib/api";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { Combobox } from "@/commons/components/ui/Combobox";
import type { PresetId } from "@nouride/wire";
import { ToolPicker } from "./ToolPicker";
import { AccountPicker, AnsweredBy } from "./AnsweredBy";
import { chatModels } from "@/commons/lib/model-kind";

/**
 * Creating an agent persona pack.
 *
 * The provider and model controls are the ones from `model.page.tsx`, deliberately: creating an
 * agent and editing its model are the same decision made at different times, and this screen used
 * to ask it with a bare text box labelled "Exact model ID your provider expects" — while naming no
 * provider at all. Whichever profile happened to resolve first got the agent, and a model that does
 * not exist there fails on the first turn with a 404 from an endpoint nobody chose.
 *
 * What it may do is a preset (`presets.ts` in the engine), Pilot unless another is picked: it decides
 * the first tools and a few lines in `AGENTS.md`, and is not shown again — the tools are switched on
 * the agent's Settings tab afterwards. The two checkboxes that were here ("Allow Terminal Command
 * Execution", "Enable Auto-Approval Mode") are gone: the first is what a preset decides, and the
 * second granted per-person `balanced`, which is already every agent's default.
 */
export function NewAgentForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** `external`: a CLI answers it — its next stop is its Brain tab, where it signs in. */
  onCreated: (id: string, external: boolean) => void | Promise<void>;
}) {
  const [id, setId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [headline, setHeadline] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [preset, setPreset] = useState<PresetId>("pilot");
  /** The coding CLI that answers it, or null for a model. */
  const [cli, setCli] = useState<string | null>(null);
  /** The account the CLI answers with — its `[external] profile`. */
  const [account, setAccount] = useState("default");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const presets = useQuery({ queryKey: ["agent-presets"], queryFn: api.agentPresets, staleTime: 5 * 60 * 1000 });

  /**
   * The preset's headline and SOUL.md, filled in for the person to keep or change (0.8.1: nobody should
   * have to write a system prompt to make an agent). Picking another preset swaps them, unless the person has written
   * their own: what they typed is never replaced.
   */
  const filled = useRef({ headline: "", soul: "" });
  useEffect(() => {
    const chosen = presets.data?.presets.find((option) => option.id === preset);
    if (!chosen) return;
    const next = { headline: chosen.headline ?? "", soul: chosen.soul ?? "" };
    // Read now: the updaters run at the next render, after `filled` holds the new ones.
    const before = filled.current;
    setHeadline((current) => (current === before.headline ? next.headline : current));
    setSystemPrompt((current) => (current === before.soul ? next.soul : current));
    filled.current = next;
  }, [presets.data, preset]);

  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers, retry: false });
  const profiles = providers.data?.providers ?? [];
  const profile = profiles.find((entry) => entry.name === provider);

  /**
   * The first profile that can actually answer, chosen once the list arrives.
   *
   * Not a `<select>` with an empty first option: that reads as a decision left to the operator when
   * the daemon already knows which profiles hold a credential, and an empty value would send them
   * back to whatever the server resolves — the behaviour this control exists to replace.
   */
  useEffect(() => {
    if (provider || profiles.length === 0) return;
    setProvider((profiles.find((entry) => entry.hasCredential) ?? profiles[0])!.name);
  }, [profiles, provider]);

  const modelList = useQuery({
    queryKey: ["provider-models", provider],
    queryFn: () => api.providerModels(provider),
    enabled: !!provider,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const models = modelList.data?.ok ? chatModels(modelList.data.models) : [];

  // The daemon's own rule for an id (`setup/service.ts`), so the button says what the save would refuse.
  const idOk = /^[a-z][a-z0-9-]{1,31}$/.test(id.trim().toLowerCase());
  // Nothing to send until it has an id, a name and a model: Create was pressed on an empty form.
  const ready = idOk && displayName.trim() !== "" && (cli !== null ? /^[a-z0-9][a-z0-9-]{0,23}$/.test(account) : model.trim() !== "");

  const create = useMutation({
    mutationFn: () =>
      api.createAgent({
        id: id.trim().toLowerCase(),
        display_name: displayName.trim(),
        system_prompt: systemPrompt,
        // An external agent's model is Nouride's own work around it — a mission's review — on the install's default.
        model: cli ? "" : model.trim(),
        ...(provider && !cli ? { provider } : {}),
        ...(cli ? { external: { cli, profile: account } } : {}),
        preset,
        ...(preset === "custom" ? { tools: [...picked] } : {}),
        ...(headline.trim() ? { headline: headline.trim() } : {}),
      }),
    onSuccess: (result) => onCreated(result.id, cli !== null),
  });

  return (
    <Card title="New Agent" className="border-primary/30 shadow-lg">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Agent ID" hint="Its short name for links and folders: lowercase letters, digits and dashes.">
            <input
              className="input w-full font-mono text-sm rounded-xl"
              value={id}
              placeholder="e.g. assistant"
              onChange={(e) => setId(e.target.value)}
            />
          </Field>
          <Field label="Display Name" hint="The name you see everywhere.">
            <input
              className="input w-full text-sm rounded-xl"
              value={displayName}
              placeholder="e.g. Assistant"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Headline" hint="Filled in from what it can do, below. Change it if you like.">
          <HeadlineField value={headline} onChange={setHeadline} placeholder={presets.data?.presets.find((option) => option.id === preset)?.headline ?? "What to bring this agent"} id="new-agent-headline" />
        </Field>

        <AnsweredBy value={cli} onChange={setCli} />

        {cli ? (
          <>
          <AccountPicker cli={cli} value={account} onChange={setAccount} />
          <p className="text-base-content/70 rounded-xl border border-base-content/10 p-3 text-xs">
            It answers with the coding CLI's own model, chosen on its Brain tab once it is made, where it signs in too.
            Nouride's own work around it (a mission's review, the memory pass) runs on the default model.
          </p>
          </>
        ) : (
          <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Provider"
              hint={profile ? `At ${profile.baseUrl}` : "Set up on the Models page."}
            >
              <select
                className="select w-full rounded-xl text-sm"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                {profiles.length === 0 && <option value="">No provider set up</option>}
                {profiles.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name} {entry.hasCredential ? "" : "(No API key)"}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Model Name" hint="Search the models this provider offers, or type an exact name.">
              <Combobox
                options={models}
                loading={modelList.isLoading}
                value={model}
                onChange={setModel}
                placeholder="e.g. claude-sonnet-5"
                required
              />
            </Field>
          </div>

          {profile && !profile.hasCredential && (
            <div className="alert alert-warning bg-warning/10 border border-warning/30 text-warning text-xs rounded-xl p-3">
              <span>This provider has no API key yet. Add one on the Models page.</span>
            </div>
          )}

          {modelList.data && !modelList.data.ok && (
            <p className="text-base-content/65 text-xs">
              Could not list its models ({modelList.data.plain ?? modelList.data.error ?? "no answer"}). Type the model's exact
              name instead; any name is accepted.
            </p>
          )}
          </>
        )}

        <Field label="Personality and instructions" hint="A starting personality from what it can do, below. Change it now or any time on its Files tab.">
          <textarea
            className="textarea min-h-32 w-full text-sm font-mono rounded-xl leading-relaxed"
            value={systemPrompt}
            placeholder="You are a helpful, precise assistant..."
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </Field>

        <Field label="What it can do" hint="Where it starts. Its tools can be changed later on its Settings tab; every agent checks with you before anything risky.">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(presets.data?.presets ?? []).map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={preset === option.id}
                onClick={() => setPreset(option.id)}
                className={`rounded-xl border p-2.5 text-left transition-all ${
                  preset === option.id ? "border-primary/40 bg-primary/10" : "border-base-content/[0.08] hover:bg-base-200/60"
                }`}
              >
                <span className="block text-xs font-semibold">{option.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-base-content/65">{option.summary}</span>
              </button>
            ))}
          </div>
        </Field>

        {preset === "custom" && presets.data ? (
          <Field label="Tools" hint="Pick what this agent may use.">
            <div className="rounded-xl border border-base-content/[0.08] bg-base-200/50 p-4">
              <ToolPicker groups={presets.data.groups} selected={picked} onChange={setPicked} />
            </div>
          </Field>
        ) : null}

        <ErrorNote error={create.error} />

        <div className="flex items-center gap-2 pt-2">
          <button
            type="submit"
            className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
            disabled={!ready || create.isPending}
            title={ready ? undefined : "Needs an id, a name and a model"}
          >
            {create.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            Create Agent
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm rounded-xl"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
