/**
 * Provider profiles — the endpoints agents run against — and, on a tab of their own, the coding CLIs and their accounts
 * that external agents answer with (0.8.1): both are where an agent's answers come from, and the sign-in they take.
 * Remade with Apple HIG: clean profile cards and endpoint probe testing. Which agent uses which
 * model is each agent's own page; here a profile only says which agents use it — and, collapsed above the list, the
 * install's model tiers and what each helper runs on (0.8.0).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Cpu, ExternalLink, Plus, Trash2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { ProviderProfileView } from "@nouride/wire";
import { Card, EmptyState, ErrorNote, Field, PageHeader } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";
import { isBundledEndpoint, nougateConsoleUrl } from "@/commons/lib/bundled-gateway";
import { useSaved } from "@/commons/hooks/use-saved";
import { FILL_PAGE, ScrollArea } from "@/commons/components/ui/ScrollCard";
import { Count, SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { ModelTiersButton } from "./components/ModelTiers";
import { CodingClis } from "./components/CodingClis";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

const KINDS = [
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { id: "openai", label: "OpenAI-compatible", baseUrl: "https://api.openai.com/v1" },
];

export default function ModelsPage({ tab }: { tab?: "clis" | undefined } = {}) {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState<"providers" | "clis">(tab ?? "providers");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["providers"] });
  const list = providers.data?.providers ?? [];
  // By wire format: the one thing that decides which models and features a profile can carry.
  const [wire, setWire] = useState<"all" | "openai" | "anthropic">("all");
  const shown = list.filter((profile) => wire === "all" || profile.kind === wire);
  const count = (kind: string) => list.filter((profile) => profile.kind === kind).length;

  return (
    <div className={FILL_PAGE}>
      <PageHeader
        ask={PAGE_ASKS.models}
        title="Models"
        description="Where your agents' answers come from: the AI providers and their keys, and the coding CLIs some agents work inside (Claude Code, Codex), with their accounts."
        actions={
          source === "clis" ? undefined : (
            <div className="flex flex-wrap items-center gap-2">
              <ModelTiersButton />
              <button
                type="button"
                className="btn btn-primary btn-sm rounded-xl gap-2 shadow-xs active:scale-95 transition-all"
                onClick={() => setAdding(true)}
              >
                <Plus size={16} /> Add Provider
              </button>
            </div>
          )
        }
      />

      <SegmentedTabs
        tabs={[
          { value: "providers" as const, label: "Model providers" },
          { value: "clis" as const, label: "Coding CLIs" },
        ]}
        value={source}
        onChange={setSource}
      />

      {/* Its own scroll, as the providers' list has: the page itself does not. */}
      {source === "clis" ? (
        <ScrollArea fill className="pr-1">
          <CodingClis />
        </ScrollArea>
      ) : null}

      {source === "providers" && adding && (
        <ProviderForm
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}

      {source !== "providers" ? null : providers.isPending ? (
        <ListLoading />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState icon={Cpu} title="No providers yet" />
        </Card>
      ) : (
        <>
        <SegmentedTabs
          tabs={[
            { value: "all" as const, label: "All", after: <Count n={list.length} /> },
            { value: "openai" as const, label: "OpenAI-compatible", after: <Count n={count("openai")} /> },
            { value: "anthropic" as const, label: "Anthropic", after: <Count n={count("anthropic")} /> },
          ]}
          value={wire}
          onChange={setWire}
        />
        {shown.length === 0 ? <EmptyState icon={Cpu} title="No provider of this kind" /> : null}
        {/* Its own scroll, so the tabs stay put over a long list. Keyed by the tab, to fade in anew (`FILL_PAGE`). */}
        <ScrollArea key={wire} fill className="space-y-4 pr-1">
          {shown.map((profile) => (
            <ProfileCard
              key={profile.name}
              profile={profile}
              usedBy={(status.data?.agents ?? [])
                .filter((agent) => agent.provider === profile.name)
                .map((agent) => agent.id)}
              onChanged={refresh}
            />
          ))}
        </ScrollArea>
        </>
      )}

    </div>
  );
}

function ProfileCard({
  profile,
  usedBy,
  onChanged,
}: {
  profile: ProviderProfileView;
  usedBy: string[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const saved = useSaved();
  const remove = useMutation({
    mutationFn: () => api.deleteProvider(profile.name),
    onSuccess: (answer) => {
      saved(answer, `Provider ${profile.name} removed`);
      onChanged();
    },
  });

  const console_ = nougateConsoleUrl(profile.baseUrl);
  // The gateway this daemon hosts has no console to link to, but it does have a page here.
  const { data: setup } = useQuery({ queryKey: ["setup"], queryFn: api.setupState });
  const bundled = isBundledEndpoint(profile.baseUrl, setup);
  const { ask, dialog } = useConfirm();

  return (
    <Card
      title={profile.name}
      description={profile.baseUrl}
      actions={
        <div className="flex items-center gap-2">
          {/*
            Only for a nougate reachable from wherever this page is open. The bundled gateway binds
            loopback and serves no console, so `nougateConsoleUrl` returns null for it rather than
            offering a link to the reader's own machine.
          */}
          {console_ && (
            <a
              href={console_}
              target="_blank"
              rel="noreferrer noopener"
              className="btn btn-ghost btn-xs rounded-lg font-medium gap-1 hover:bg-base-200"
            >
              Console <ExternalLink size={11} />
            </a>
          )}
          {bundled && (
            <Link to="/llm-gateway" className="btn btn-ghost btn-xs rounded-lg font-medium gap-1 hover:bg-base-200">
              LLM Gateway {/* plain-words-ok: the admin page's own name, as the menu has it */}
            </Link>
          )}
          <span className={`badge badge-sm shrink-0 whitespace-nowrap font-semibold ${profile.hasCredential ? "badge-success shadow-xs" : "badge-error shadow-xs"}`}>
            {profile.hasCredential ? "Key Active" : "No Key Set"}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg font-medium hover:bg-base-200"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Cancel" : "Edit"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg text-error hover:bg-error/10"
            disabled={usedBy.length > 0}
            title={usedBy.length > 0 ? `Used by: ${usedBy.join(", ")}` : "Delete provider"}
            aria-label={`Delete provider ${profile.name}`}
            onClick={async () => {
              const yes = await ask({
                title: `Remove provider ${profile.name}?`,
                body: profile.hasCredential
                  ? "Its settings and its stored key are deleted. No agent uses it, so nothing stops answering."
                  : "Its settings are deleted. No agent uses it, so nothing stops answering.",
                confirmLabel: "Remove",
              });
              if (yes) remove.mutate();
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      }
    >
      {editing ? (
        <ProviderForm
          existing={profile}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          embedded
        />
      ) : (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
          <div className="p-3 rounded-xl bg-base-200/40 border border-base-content/[0.05]">
            <dt className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 mb-1 font-mono">
              Kind
            </dt>
            <dd className="font-semibold capitalize text-base-content">{profile.kind}</dd>
          </div>
          <div className="p-3 rounded-xl bg-base-200/40 border border-base-content/[0.05]">
            <dt className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 mb-1 font-mono">
              Key Saved As
            </dt>
            <dd className="font-mono text-xs text-base-content/85 font-medium">{profile.apiKeySecret}</dd>
          </div>
          <div className="p-3 rounded-xl bg-base-200/40 border border-base-content/[0.05]">
            <dt className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 mb-1 font-mono">
              Used By
            </dt>
            <dd className="font-medium">
              {usedBy.length > 0 ? (
                <span className="text-primary font-semibold">{usedBy.join(", ")}</span>
              ) : (
                <span className="text-base-content/65">No agent</span>
              )}
            </dd>
          </div>
        </dl>
      )}
      <ErrorNote error={remove.error} />
      {dialog}
    </Card>
  );
}

function ProviderForm({
  existing,
  onClose,
  onSaved,
  embedded = false,
}: {
  existing?: ProviderProfileView;
  onClose: () => void;
  onSaved: () => void;
  embedded?: boolean;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState(existing?.kind ?? "openai");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? KINDS[1]?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");

  const probe = useMutation({ mutationFn: () => api.probe({ kind, baseUrl, apiKey }) });
  const saved = useSaved();
  const save = useMutation({
    mutationFn: () =>
      api.saveProviderProfile({
        name,
        kind,
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      }),
    onSuccess: (answer) => {
      saved(answer, `Provider ${name}`, "The next call through it uses these.");
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
        <Field
          label="Name"
          hint="How agents refer to it."
        >
          <input
            className="input w-full rounded-xl text-sm"
            value={name}
            disabled={Boolean(existing)}
            placeholder="e.g. anthropic-main, openai-default"
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>

        <Field label="Kind" hint="How Nouride talks to it.">
          <select
            className="select w-full rounded-xl text-sm"
            value={kind}
            onChange={(e) => {
              const next = e.target.value as "openai" | "anthropic";
              setKind(next);
              const preset = KINDS.find((entry) => entry.id === next);
              if (preset && !existing) setBaseUrl(preset.baseUrl);
            }}
          >
            {KINDS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Base URL">
        <input
          className="input w-full font-mono text-sm rounded-xl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
          required
        />
      </Field>

      <Field
        label="API Key"
        hint={
          existing
            ? "Leave it empty to keep the key saved."
            : "Kept safe on this server and never shown again."
        }
      >
        <input
          className="input w-full font-mono text-sm rounded-xl"
          type="password"
          autoComplete="off"
          placeholder={existing ? "•••••••••••• (unchanged)" : ""}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Field>

      {probe.data && (
        <div className={`alert ${probe.data.ok ? "alert-success bg-success/10 border-success/30 text-success" : "alert-error bg-error/10 border-error/30 text-error"} text-xs rounded-xl p-3`}>
          {probe.data.ok ? (
            <div className="flex items-center gap-2 font-medium">
              <Check size={16} />
              <span>Connected: it offers {probe.data.models.length} models.</span>
            </div>
          ) : (
            <span>{probe.data.plain ?? probe.data.error ?? "It did not answer."}</span>
          )}
        </div>
      )}
      <ErrorNote error={save.error} />

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="submit"
          className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
          disabled={save.isPending}
        >
          {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
          {existing ? "Save Changes" : "Add Profile"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm rounded-xl"
          disabled={!apiKey.trim() || !baseUrl.trim() || probe.isPending}
          onClick={() => probe.mutate()}
        >
          {probe.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
          Test Connection
        </button>
        <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );

  if (embedded) return body;
  return (
    <Card title="Add a Provider" className="border-primary/30 shadow-lg">
      {body}
    </Card>
  );
}
