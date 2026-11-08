/**
 * Web Search — which service `web_search` asks, set up without opening `config.toml`.
 *
 * Four choices (see `ProviderPicker`), the steps to get what each one needs beside it, and a Test
 * that runs a real search through the same tool the agents use, with what the form holds rather than
 * what is saved. A key can be pasted — it goes to Secrets on save, and only its name to the config —
 * or picked from Secrets.
 *
 * The tool is built when the daemon starts, so a save is not live until a restart. The page says so
 * and offers one, rather than leaving somebody to wonder why the agents still search the old way.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FlaskConical, Save, Search } from "lucide-react";
import { useRestartsFinished } from "@/commons/lib/restart";
import { api } from "@/commons/lib/api";
import type { WebSearchMode, WebSearchPatch, WebSearchSettings, WebSearchTest } from "@/commons/lib/api.web-search";
import { isAdmin, useMe } from "@/commons/lib/session";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";
import { Card, ErrorNote, Field, PageHeader } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { cn } from "@/commons/lib/utils";
import { ApiKeyField, type KeySource } from "./components/ApiKeyField";
import { BraveGuide, CustomGuide, FreeGuide, SearxngGuide } from "./components/Guides";
import { ProviderPicker } from "./components/ProviderPicker";
import { TestResult } from "./components/TestResult";
import { RestartNeeded } from "@/commons/components/ui/RestartNeeded";
import { useSaved } from "@/commons/hooks/use-saved";

interface Draft {
  mode: WebSearchMode;
  endpoint: string;
  keySource: KeySource;
  keyValue: string;
  secretName: string;
  fallbackEnabled: boolean;
  allowPrivateUrls: boolean;
}

function draftFrom(settings: WebSearchSettings): Draft {
  return {
    mode: settings.mode,
    endpoint: settings.endpoint,
    keySource: settings.apiKeyOrigin === "missing" ? "paste" : "secret",
    keyValue: "",
    secretName: settings.apiKeySecret,
    fallbackEnabled: settings.fallbackEnabled,
    allowPrivateUrls: settings.allowPrivateUrls,
  };
}

function patchFrom(draft: Draft): WebSearchPatch {
  const usesKey = draft.mode === "brave" || draft.mode === "custom";
  const usesEndpoint = draft.mode === "searxng" || draft.mode === "custom";
  return {
    mode: draft.mode,
    fallbackEnabled: draft.fallbackEnabled,
    ...(usesEndpoint ? { endpoint: draft.endpoint.trim(), allowPrivateUrls: draft.allowPrivateUrls } : {}),
    ...(usesKey ? { apiKeySecret: draft.secretName.trim() } : {}),
    ...(usesKey && draft.keySource === "paste" && draft.keyValue ? { apiKeyValue: draft.keyValue } : {}),
  };
}

/** A host on this machine or this network: the SSRF guard's business, and the toggle's cue. */
function looksPrivate(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return (
      !host.includes(".") ||
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host)
    );
  } catch {
    return false;
  }
}

const EFFECTIVE_LABEL: Record<WebSearchSettings["effective"], string> = {
  free: "Free sources",
  brave: "Brave Search API",
  searxng: "SearXNG",
  unavailable: "Not working",
};

/** Not `StatusDot`: its words are a connection's ("Connecting"), and a saved setting is not connecting. */
function StatusBadge({ settings }: { settings: WebSearchSettings }) {
  const [tone, label] =
    settings.effective === "unavailable"
      ? ["border-error/20 bg-error/10 text-error", "Not working"]
      : settings.restartPending
        ? ["border-warning/20 bg-warning/10 text-warning", "Restart needed"]
        : ["border-success/20 bg-success/10 text-success", "Active"];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", tone)}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

export default function WebSearchPage() {
  const me = useMe();
  const settings = useQuery({ queryKey: ["web-search"], queryFn: api.webSearch });
  const secrets = useQuery({ queryKey: ["secrets"], queryFn: api.secrets });
  const queryClient = useQueryClient();
  const admin = isAdmin(me.data ?? null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [test, setTest] = useState<WebSearchTest | null>(null);
  const [saved, setSaved] = useState(false);
  // A restart applies what was saved: the notice goes with it, and the page's own reading says what is in force.
  const restarts = useRestartsFinished();
  useEffect(() => setSaved(false), [restarts]);

  // Seeded once from the server, then the form's own: a refetch must not overwrite what is being typed.
  useEffect(() => {
    if (settings.data && !draft) setDraft(draftFrom(settings.data));
  }, [settings.data, draft]);

  const update = (patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setTest(null);
    setSaved(false);
  };

  const runTest = useMutation({
    mutationFn: (current: Draft) => api.testWebSearch(patchFrom(current)),
    onSuccess: setTest,
  });

  const announce = useSaved();
  const save = useMutation({
    mutationFn: (current: Draft) => api.setWebSearch(patchFrom(current)),
    onSuccess: (result) => {
      setDraft(draftFrom(result.settings));
      setSaved(true);
      announce(result, `Web search: ${EFFECTIVE_LABEL[result.settings.effective]}`);
      void queryClient.invalidateQueries({ queryKey: ["web-search"] });
      void queryClient.invalidateQueries({ queryKey: ["secrets"] });
    },
  });

  const current = settings.data;
  const editable = admin && Boolean(current?.editable);
  const busy = save.isPending;
  const dirty = Boolean(current && draft) && JSON.stringify(patchFrom(draft!)) !== JSON.stringify(patchFrom(draftFrom(current!)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Web Search"
        description="Where your agents look things up. The free sources work with no setup; a search API gives steadier results and image search."
      />

      <ErrorNote error={settings.error ?? save.error ?? runTest.error} />

      {current ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Search size={19} />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-base-content/65 font-mono">
                  {current.restartPending ? "After a restart, agents search with" : "Agents search with"}
                </p>
                <p className="text-base font-semibold text-base-content">{EFFECTIVE_LABEL[current.effective]}</p>
                {/* What it needs in the page's words (0.8.23); why, in the settings file's, under Details. */}
                {current.problem ? (
                  <div className="text-xs text-error">
                    <p>{current.plain ?? current.problem}</p>
                    {current.plain ? (
                      <Details>
                        <p className="break-words">{current.problem}</p>
                      </Details>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <StatusBadge settings={current} />
          </div>
          {current.restartPending || saved ? (
            <div className="mt-4">
              <RestartNeeded>the search tool is set up when Nouride starts</RestartNeeded>
            </div>
          ) : null}
        </Card>
      ) : null}

      {draft && current ? (
        <>
          <Card title="Provider" description="Pick one. You can test it before saving, and switch back at any time.">
            <ProviderPicker value={draft.mode} active={current.mode} disabled={!editable || busy} onChange={(mode) => update({ mode })} />
          </Card>

          <Card title={draft.mode === "free" ? "About the free sources" : "Set up"}>
            <div className="space-y-5">
              {draft.mode === "free" ? <FreeGuide /> : null}
              {draft.mode === "brave" ? <BraveGuide /> : null}
              {draft.mode === "searxng" ? <SearxngGuide /> : null}
              {draft.mode === "custom" ? <CustomGuide /> : null}

              {draft.mode === "searxng" || draft.mode === "custom" ? (
                <Field
                  label={draft.mode === "searxng" ? "SearXNG Search Address" : "Search Address"}
                  hint={draft.mode === "searxng" ? "Your SearXNG's address, ending in /search." : "The full web address searches are sent to."}
                >
                  <input
                    className="input w-full rounded-xl font-mono text-sm"
                    placeholder={draft.mode === "searxng" ? "http://searxng:8080/search" : "https://search.example.com/res/v1/web/search"}
                    value={draft.endpoint}
                    disabled={!editable || busy}
                    onChange={(event) => update({ endpoint: event.target.value })}
                  />
                </Field>
              ) : null}

              {(draft.mode === "searxng" || draft.mode === "custom") && (draft.allowPrivateUrls || looksPrivate(draft.endpoint)) ? (
                <ToggleRow
                  label="Allow addresses on this machine or network"
                  hint={`Needed when the search service is on a private address${looksPrivate(draft.endpoint) ? ", as this one is" : ""}. It also lets agents open pages on your network, so leave it off unless you need it.`}
                  checked={draft.allowPrivateUrls}
                  disabled={!editable || busy}
                  onChange={(allowPrivateUrls) => update({ allowPrivateUrls })}
                />
              ) : null}

              {draft.mode === "brave" || draft.mode === "custom" ? (
                <ApiKeyField
                  source={draft.keySource}
                  onSource={(keySource) => update({ keySource })}
                  value={draft.keyValue}
                  onValue={(keyValue) => update({ keyValue })}
                  secretName={draft.secretName}
                  onSecretName={(secretName) => update({ secretName })}
                  secrets={secrets.data?.secrets ?? []}
                  loadingSecrets={secrets.isLoading}
                  optional={draft.mode === "custom"}
                  disabled={!editable || busy}
                />
              ) : null}

              {draft.mode !== "free" ? (
                <ToggleRow
                  label="Fall back to the free sources"
                  hint="When this provider is rate-limited, down or slow, search the free sources instead of failing."
                  checked={draft.fallbackEnabled}
                  disabled={!editable || busy}
                  onChange={(fallbackEnabled) => update({ fallbackEnabled })}
                />
              ) : null}

              {test ? <TestResult result={test} /> : null}

              <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-base-content/[0.06] pt-4">
                {dirty ? <span className="mr-auto text-xs text-base-content/65">Unsaved changes</span> : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm rounded-xl gap-2"
                  disabled={!admin || runTest.isPending || busy}
                  onClick={() => runTest.mutate(draft)}
                >
                  <FlaskConical size={15} className={runTest.isPending ? "animate-pulse" : ""} />
                  {runTest.isPending ? "Searching…" : "Test"}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm rounded-xl gap-2 shadow-xs active:scale-95 transition-all"
                  disabled={!editable || !dirty || busy}
                  onClick={() => save.mutate(draft)}
                >
                  <Save size={15} /> {save.isPending ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
