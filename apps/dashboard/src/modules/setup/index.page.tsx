/**
 * The first-run wizard.
 * Remade with Apple HIG: clear 3-step visual progress (provider, agent, memory), segmented preset selector,
 * ambient background blur, interactive probe tests, and tactile buttons.
 */

import { HeadlineField } from "@/commons/components/ui/HeadlineField";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Sparkles } from "lucide-react";
import { Combobox } from "@/commons/components/ui/Combobox";
import { api, type SetupState } from "@/commons/lib/api";
import { gatewayMount } from "@/commons/lib/bundled-gateway";
import { GatewayOffer, GatewayStep } from "./GatewayStep";
import { MemoryStep } from "./MemoryStep";
import { Mascot } from "@/commons/components/brand/Mascot";

const PRESETS: Record<string, { label: string; baseUrl: string; hint: string }> = {
  openai: {
    label: "OpenAI-compatible",
    baseUrl: "https://api.openai.com/v1",
    hint: "Most providers: OpenAI, OpenRouter, Ollama, Nougate and others that work like OpenAI.",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    hint: "Claude, from Anthropic, or a service that works like it.",
  },
};

export default function SetupPage() {
  const { data: state } = useQuery({ queryKey: ["setup"], queryFn: api.setupState });
  const step = !state?.hasProvider ? 1 : !state.hasAgent ? 2 : 3;

  return (
    <div className="relative min-h-screen py-10 px-4 flex flex-col items-center justify-center selection:bg-primary/20 overflow-clip">

      <div className="relative w-full max-w-xl space-y-6">
        <header className="text-center space-y-2">
          <Mascot pose="waving" decorative className="mx-auto w-28" />
          <h1 className="text-2xl text-base-content sm:text-3xl">Set up Nouride</h1>
          <p className="text-base-content/65 text-sm max-w-md mx-auto">
            Connect a model, create your first agent, and choose how it remembers. Three short steps.
          </p>
        </header>

        {/* Step Indicator */}
        <div className="flex items-center justify-center gap-3">
          <div className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all ${step >= 1 ? "bg-primary text-primary-content shadow-xs" : "bg-base-200 text-base-content/65"}`}>
            <span className="size-4 rounded-full bg-white/20 grid place-items-center text-[10px]">1</span>
            <span>Provider</span>
          </div>
          <div className="w-8 h-0.5 bg-base-content/10" />
          <div className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all ${step >= 2 ? "bg-primary text-primary-content shadow-xs" : "bg-base-200 text-base-content/65"}`}>
            <span className="size-4 rounded-full bg-white/20 grid place-items-center text-[10px]">2</span>
            <span>Agent</span>
          </div>
          <div className="w-8 h-0.5 bg-base-content/10" />
          <div className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all ${step >= 3 ? "bg-primary text-primary-content shadow-xs" : "bg-base-200 text-base-content/65"}`}>
            <span className="size-4 rounded-full bg-white/20 grid place-items-center text-[10px]">3</span>
            <span>Memory</span>
          </div>
        </div>

        {step === 1 ? <ProviderStep /> : step === 2 ? <AgentStep /> : <MemoryStep />}
      </div>
    </div>
  );
}

/**
 * An API key first, as it always was — and on a build carrying the LLM gateway, a second way under it
 * that needs none (`GatewayStep.tsx`).
 */
function ProviderStep() {
  // Its own read of the same query, not a prop: this is cached by key, so it costs nothing, and
  // threading a field through one component to reach one button is how props start meaning nothing.
  const { data: state } = useQuery({ queryKey: ["setup"], queryFn: api.setupState });
  const mount = gatewayMount(state);
  const [viaGateway, setViaGateway] = useState(false);
  if (viaGateway && mount) return <GatewayStep mount={mount} onBack={() => setViaGateway(false)} />;
  return <KeyForm state={state} onUseGateway={() => setViaGateway(true)} />;
}

function KeyForm({ state, onUseGateway }: { state: SetupState | undefined; onUseGateway: () => void }) {
  const [kind, setKind] = useState<keyof typeof PRESETS>("openai");
  const [name, setName] = useState("openai");
  const [baseUrl, setBaseUrl] = useState(PRESETS.openai?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const queryClient = useQueryClient();

  const [tested, setTested] = useState(false);

  const probe = useMutation({
    mutationFn: () => api.probeProvider({ kind, base_url: baseUrl, api_key: apiKey }),
    onSuccess: (result) => {
      if (!result.ok) throw new Error(result.plain || result.error || "Connection failed.");
      setTested(true);
      queryClient.prefetchQuery({
        queryKey: ["models"],
        queryFn: async () => result.models,
        staleTime: Infinity,
      });
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      const result = await api.saveProvider({ kind, name, base_url: baseUrl, api_key: apiKey, skip_probe: true });
      const modelsResult = await api.setupModels();
      queryClient.setQueryData(["models"], modelsResult.models);
      return result;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["setup"] });
    },
  });

  const resetTested = () => { setTested(false); probe.reset(); };
  const preset = PRESETS[kind];

  return (
    <div className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-6 sm:p-8 shadow-soft space-y-5">
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div>
          <h2 className="text-lg font-bold tracking-tight text-base-content">Connect an AI provider</h2>
          <p className="text-base-content/65 text-sm mt-0.5">
            One is enough to start. You can add more later, on the Models page.
          </p>
        </div>

        {/* Preset Selector */}
        <div className="inline-flex p-1 rounded-2xl bg-base-200/80 border border-base-content/[0.08] w-full">
          {Object.entries(PRESETS).map(([value, p]) => (
            <button
              key={value}
              type="button"
              className={`flex-1 py-2 text-sm font-semibold rounded-xl transition-all active:scale-95 ${
                kind === value
                  ? "bg-base-100 text-base-content shadow-xs"
                  : "text-base-content/65 hover:text-base-content"
              }`}
              onClick={() => {
                setKind(value as keyof typeof PRESETS);
                setBaseUrl(p.baseUrl);
                resetTested();
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-base-content/65 -mt-2 text-xs">{preset?.hint}</p>

        <div className="space-y-3.5">
          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono">Name</span>
            <input
              className="input w-full font-mono text-sm rounded-xl"
              value={name}
              onChange={(e) =>
                setName(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9_-]+/g, "-")
                    .replace(/^-+|-+$/g, "")
                    .slice(0, 32),
                )
              }
              placeholder="e.g. openai, anthropic, nougate"
              required
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono">Base URL</span>
            <input
              className="input w-full font-mono text-sm rounded-xl"
              value={baseUrl}
              onChange={(e) => { setBaseUrl(e.target.value); resetTested(); }}
              placeholder="https://api.openai.com/v1"
              required
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono">API Key</span>
            <input
              className="input w-full font-mono text-sm rounded-xl"
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); resetTested(); }}
              autoComplete="off"
              placeholder="••••••••••••"
              required
            />
            <span className="text-base-content/65 block text-[11px] mt-1">
              Kept safe on this server and never shown again.
            </span>
          </label>
        </div>

        {(probe.isError || save.isError) && (
          <div className="alert alert-error bg-error/10 border border-error/30 text-error text-xs rounded-xl p-3 flex items-center gap-2">
            <AlertTriangle size={15} className="shrink-0" />
            <span>{((probe.error || save.error) as Error).message}</span>
          </div>
        )}

        {tested && (
          <div className="alert alert-success bg-success/10 border border-success/30 text-success text-xs rounded-xl p-3 flex items-center gap-2">
            <Check size={16} className="shrink-0" />
            <span className="font-semibold">Connected, and it answers.</span>
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            className={`btn btn-sm rounded-xl flex-1 font-semibold active:scale-95 transition-all ${tested ? "btn-success btn-outline" : "btn-ghost bg-base-200 border border-base-content/10"}`}
            disabled={probe.isPending || !baseUrl || !apiKey}
            onClick={() => probe.mutate()}
          >
            {probe.isPending ? (
              <><Loader2 size={15} className="animate-spin" /> Verifying…</>
            ) : tested ? (
              <><Check size={15} /> Verified</>
            ) : (
              "Test Connection"
            )}
          </button>
          <button
            type="submit"
            className="btn btn-primary btn-sm rounded-xl flex-1 font-semibold shadow-md active:scale-95 transition-all"
            disabled={!tested || save.isPending}
          >
            {save.isPending && <Loader2 size={15} className="animate-spin" />}
            {save.isPending ? "Saving…" : "Save & Continue"}
          </button>
        </div>
      </form>

      <GatewayOffer state={state} onUse={onUseGateway} />
    </div>
  );
}

function AgentStep() {
  const queryClient = useQueryClient();
  const cachedModels = queryClient.getQueryData<string[]>(["models"]);

  const { data: fetched, isLoading: modelsLoading } = useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      const result = await api.setupModels();
      return result.models;
    },
    enabled: !cachedModels?.length,
    staleTime: Infinity,
  });

  const models = cachedModels?.length ? cachedModels : fetched ?? [];

  // The first agent is a Pilot named NouridePilot (the owner, 2026-11-06), as `nouride setup` makes it (`FIRST_AGENT`).
  const [id, setId] = useState("nouridepilot");
  const [displayName, setDisplayName] = useState("NouridePilot");
  // Empty until the person types: the first model on the list was chosen for them, and rarely the one they wanted.
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [headline, setHeadline] = useState("");
  const presets = useQuery({ queryKey: ["agent-presets"], queryFn: api.agentPresets, staleTime: 5 * 60 * 1000, retry: false });
  /**
   * The Pilot's headline and SOUL.md, filled in once they arrive, for the person to keep or change, as the New Agent form
   * fills a Pilot's. It had "My First Agent" and a generic prompt of its own. Once: a refetch never refills a field the
   * person emptied. Left empty when the presets do not come, the daemon writes the Pilot's (`service.ts`).
   */
  const filled = useRef(false);
  useEffect(() => {
    const pilot = presets.data?.presets.find((option) => option.id === "pilot");
    if (!pilot || filled.current) return;
    filled.current = true;
    setHeadline((current) => current || (pilot.headline ?? ""));
    setSystemPrompt((current) => current || (pilot.soul ?? ""));
  }, [presets.data]);
  const create = useMutation({
    mutationFn: () =>
      api.createAgent({
        id,
        display_name: displayName,
        system_prompt: systemPrompt,
        model,
        preset: "pilot",
        ...(headline.trim() ? { headline: headline.trim() } : {}),
      }),
    // On to the memory step: the setup state now says there is an agent.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["setup"] });
    },
  });

  return (
    <div className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-6 sm:p-8 shadow-soft space-y-5">
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="flex items-center gap-2 text-success text-xs font-semibold">
          <Check size={16} />
          <span>Provider connected. Now customize your agent.</span>
        </div>

        <div>
          <h2 className="text-lg font-bold tracking-tight text-base-content">Create your first agent</h2>
          {/* No switches: the first agent is always a Pilot (`presets.ts`), and tools can be changed on
              its page later. What it may do is said in one line rather than asked. */}
          <p className="text-base-content/65 text-sm mt-0.5">
            It can handle anything you ask and checks with you before anything risky.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono">Display Name</span>
            <input
              className="input w-full rounded-xl text-sm"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setId(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]+/g, "-")
                    .replace(/^-+|-+$/g, "")
                    .slice(0, 32),
                );
              }}
              required
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono">Agent ID</span>
            <input
              className="input w-full font-mono text-sm rounded-xl"
              value={id}
              onChange={(e) => setId(e.target.value)}
              required
            />
          </label>
        </div>

        {/* A div rather than a `label` like its neighbours: the suggestion rows are buttons, and a
            wrapping label forwards every click inside it to the input it names. */}
        <div className="space-y-1">
          <label
            htmlFor="setup-model"
            className="block text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono"
          >
            Model Name
          </label>
          <Combobox
            id="setup-model"
            options={models}
            loading={modelsLoading}
            value={model}
            onChange={setModel}
            required
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="setup-headline" className="block text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono">
            Headline
          </label>
          <HeadlineField value={headline} onChange={setHeadline} placeholder={presets.data?.presets.find((option) => option.id === "pilot")?.headline ?? "What to bring this agent"} id="setup-headline" />
        </div>

        <label className="block space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono">Personality and instructions</span>
          <textarea
            className="textarea h-40 w-full font-mono text-sm rounded-xl leading-relaxed"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
          <span className="block text-xs text-base-content/65">The Pilot's own personality, filled in. Change it now or any time on its Files tab.</span>
        </label>

        {create.isError && (
          <div className="alert alert-error bg-error/10 border border-error/30 text-error text-xs rounded-xl p-3 flex items-center gap-2">
            <AlertTriangle size={15} className="shrink-0" />
            <span>{(create.error as Error).message}</span>
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary w-full rounded-xl gap-2 shadow-md shadow-primary/25 font-semibold active:scale-95 transition-all text-sm"
          disabled={create.isPending}
        >
          {create.isPending ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
          Complete Setup & Enter Dashboard
        </button>
      </form>
    </div>
  );
}

