/**
 * Sign in to an AI account through the bundled gateway — no API key.
 *
 * What the setup wizard shows after "Use Nougate LLM Gateway". The gateway already knows how to sign
 * in to each upstream — OAuth, a device code, or a pasted token — and says, per provider, what the
 * flow is and what to call it (`accountFlow`, `accountCopy`). This is a list of those sign-ins, drawn
 * from that and nothing else, talking to the gateway's own API through this daemon (`gateway-api.ts`).
 * It knows no provider by name, so a provider the gateway adds needs no change here. Anything beyond signing in — keys, usage, custom providers — is on the LLM
 * Gateway page, once setup is done.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, LogIn } from "lucide-react";
import { copyText } from "@/commons/lib/clipboard";
import { gatewayApi, parsePastedCode, signInHref, type GatewayProvider, type SignInStart } from "./gateway-api";
import { accountProviders, providerCopy } from "./gateway-providers";

export function ConnectAccounts({ mount }: { mount: string }) {
  const gateway = gatewayApi(mount);
  const providers = useQuery({ queryKey: ["llm-gateway", "providers"], queryFn: gateway.providers });
  const [open, setOpen] = useState<string | null>(null);
  const rows = accountProviders(providers.data);

  if (providers.isPending) {
    return (
      <div className="flex items-center justify-center py-8 text-base-content/65">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }
  if (providers.isError) {
    return (
      <div className="alert alert-error bg-error/10 border border-error/30 text-error text-xs rounded-xl p-3 flex items-center gap-2">
        <AlertTriangle size={15} className="shrink-0" />
        <span>Nougate did not answer: {(providers.error as Error).message}</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((provider) => (
        <ProviderRow
          key={provider.id}
          mount={mount}
          provider={provider}
          open={open === provider.id}
          onOpen={() => setOpen(open === provider.id ? null : provider.id)}
          onDone={() => setOpen(null)}
        />
      ))}
    </div>
  );
}

function ProviderRow(props: {
  mount: string;
  provider: GatewayProvider;
  open: boolean;
  onOpen: () => void;
  onDone: () => void;
}) {
  const { provider } = props;
  const copy = providerCopy(provider);
  const connected = provider.accountCount > 0;
  const full = provider.accountLimit !== null && provider.accountCount >= provider.accountLimit;

  return (
    <div className={`rounded-2xl border transition-colors ${connected ? "border-success/40 bg-success/[0.04]" : "border-base-content/10 bg-base-200/40"}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-base-content flex items-center gap-2">
            {copy.name}
            {connected && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-success">
                <Check size={12} /> {provider.accountCount === 1 ? "signed in" : `${provider.accountCount} accounts`}
              </span>
            )}
          </p>
          <p className="text-[11px] text-base-content/65 truncate">{copy.hint}</p>
        </div>
        <button
          type="button"
          className={`btn btn-xs rounded-lg font-semibold gap-1 ${connected ? "btn-ghost" : "btn-primary"}`}
          onClick={props.onOpen}
          disabled={full && !props.open}
        >
          {props.open ? "Cancel" : connected ? "Add another" : (<><LogIn size={12} /> Sign in</>)}
        </button>
      </div>
      {props.open && <SignIn mount={props.mount} provider={provider} onDone={props.onDone} />}
    </div>
  );
}

/**
 * The open row: what it shows is decided by the provider's declared flow and by what the gateway
 * answers, never by which provider it is.
 */
function SignIn({ mount, provider, onDone }: { mount: string; provider: GatewayProvider; onDone: () => void }) {
  const queryClient = useQueryClient();
  const finished = async () => {
    await queryClient.invalidateQueries({ queryKey: ["llm-gateway", "providers"] });
    onDone();
  };
  // Nothing to start: the person brings a token they got from the provider.
  if (provider.accountFlow === "oauth-token") return <TokenPaste mount={mount} provider={provider} onSuccess={finished} />;
  return <StartedSignIn mount={mount} provider={provider} onSuccess={finished} />;
}

function StartedSignIn({ mount, provider, onSuccess: finished }: { mount: string; provider: GatewayProvider; onSuccess: () => void }) {
  const gateway = gatewayApi(mount);
  const start = useMutation({ mutationFn: () => gateway.startSignIn(provider.id) });

  // Started once, when the row opens: both flows begin with the same request, and what it answers
  // decides which of the two this becomes. A ref, so a development double-mount does not start a
  // second sign-in and orphan the first one's code.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start.mutate();
  }, [start]);

  if (start.isPending || start.isIdle) {
    return (
      <div className="border-t border-base-content/10 px-4 py-4 flex items-center gap-2 text-xs text-base-content/65">
        <Loader2 size={14} className="animate-spin" /> Starting sign-in…
      </div>
    );
  }
  if (start.isError || !start.data) {
    return <Failure message={(start.error as Error | null)?.message ?? "The sign-in could not start."} />;
  }
  if (start.data.step === "device_flow" && start.data.device_code) {
    return <DeviceCode mount={mount} provider={provider} flow={start.data} onSuccess={finished} />;
  }
  if (start.data.redirectUrl) {
    return <OAuthPaste mount={mount} provider={provider} url={signInHref(mount, start.data.redirectUrl)} onSuccess={finished} />;
  }
  return <Failure message="Nougate sent back neither a sign-in link nor a code. Try again." />;
}

function Failure({ message }: { message: string }) {
  return (
    <div className="border-t border-base-content/10 px-4 py-3 flex items-center gap-2 text-xs text-error">
      <AlertTriangle size={14} className="shrink-0" /> {message}
    </div>
  );
}

/**
 * Text with `code` in backticks, as the gateway's copy writes addresses — drawn as code, not as
 * stray backticks.
 */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 === 1 ? <span key={i} className="font-mono text-base-content/70">{part}</span> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

/**
 * OAuth: open, approve, paste back.
 *
 * Where the tab ends, and what to bring back, is the provider's to say (`accountCopy.consent`) —
 * usually a `localhost` address that, from the person's own machine, does not load. Saying so before
 * it happens is the difference between a step and a scare.
 */
function OAuthPaste(props: { mount: string; provider: GatewayProvider; url: string; onSuccess: () => void }) {
  const gateway = gatewayApi(props.mount);
  const copy = props.provider.accountCopy;
  const [pasted, setPasted] = useState("");
  const finish = useMutation({
    mutationFn: async () => {
      const parsed = parsePastedCode(pasted);
      if (!parsed) throw new Error("Paste the address the sign-in tab ended on.");
      const result = await gateway.finishOAuth(props.provider.id, parsed.code, parsed.state);
      if (result?.success === false || result?.error) throw new Error(result.error ?? "The sign-in was refused.");
      return result;
    },
    onSuccess: props.onSuccess,
  });

  return (
    <div className="border-t border-base-content/10 px-4 py-4 space-y-3 text-xs">
      <Step n={1} title="Open the sign-in page and approve">
        {copy?.intro && <p className="text-base-content/65 leading-relaxed"><Words text={copy.intro} /></p>}
        <a href={props.url} target="_blank" rel="noreferrer noopener" className="btn btn-sm btn-primary rounded-xl gap-1.5 font-semibold mt-1.5">
          <ExternalLink size={13} /> {copy?.button ?? "Open sign-in"}
        </a>
      </Step>
      <Step n={2} title={copy?.pasteLabel ?? "Paste the address you end on"}>
        <p className="text-base-content/65 leading-relaxed">
          <Words text={copy?.consent ?? "The tab may finish on a page that does not load; that is expected. Copy its full address from the address bar."} />
        </p>
        <textarea
          className="textarea w-full font-mono text-[11px] rounded-xl mt-1.5 h-20"
          placeholder={copy?.pastePlaceholder ?? "Paste the full address, or the code"}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
      </Step>
      {finish.isError && <p className="text-error flex items-center gap-1.5"><AlertTriangle size={13} /> {(finish.error as Error).message}</p>}
      <button
        type="button"
        className="btn btn-sm btn-primary rounded-xl w-full font-semibold"
        disabled={!pasted.trim() || finish.isPending}
        onClick={() => finish.mutate()}
      >
        {finish.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
        Connect
      </button>
    </div>
  );
}

/**
 * Device code: a short code to enter on the issuer's site, then nothing — this side waits.
 *
 * Polled at the interval the issuer asked for. The gateway does the exchange; this only asks whether
 * it is done yet, and stops the moment it is, it expired, or the row was closed.
 */
function DeviceCode(props: { mount: string; provider: GatewayProvider; flow: SignInStart; onSuccess: () => void }) {
  const gateway = gatewayApi(props.mount);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const link = props.flow.verification_uri_complete ?? props.flow.verification_uri ?? "";

  useEffect(() => {
    let stopped = false;
    const every = Math.max(3, props.flow.interval ?? 5) * 1000;
    const tick = async () => {
      if (stopped) return;
      try {
        const result = await gateway.pollDevice(props.provider.id, props.flow.device_code!);
        if (stopped) return;
        if (result.status === "success") return props.onSuccess();
        if (result.status === "expired") return setError(result.error ?? "The code expired. Close this and sign in again.");
      } catch (err) {
        if (!stopped) setError((err as Error).message);
        return;
      }
      timer = setTimeout(tick, every);
    };
    let timer = setTimeout(tick, every);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [props.flow.device_code]);

  return (
    <div className="border-t border-base-content/10 px-4 py-4 space-y-3 text-xs">
      <Step n={1} title="Enter this code on the sign-in page">
        <div className="flex items-center gap-2 mt-1.5">
          <span className="font-mono text-lg font-bold tracking-widest text-base-content">{props.flow.user_code}</span>
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg"
            onClick={() => void copyText(props.flow.user_code ?? "").then(() => setCopied(true))}
            aria-label="Copy the code"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
        {link && (
          <a href={link} target="_blank" rel="noreferrer noopener" className="btn btn-sm btn-primary rounded-xl gap-1.5 font-semibold mt-2">
            <ExternalLink size={13} /> {props.provider.accountCopy?.button ?? "Open sign-in page"}
          </a>
        )}
      </Step>
      <Step n={2} title="Approve it there">
        {error ? (
          <p className="text-error flex items-center gap-1.5"><AlertTriangle size={13} /> {error}</p>
        ) : (
          <p className="text-base-content/65 flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" /> Waiting for approval. This finishes by itself.
          </p>
        )}
      </Step>
    </div>
  );
}

/**
 * A token: the person got it from the provider (how is the provider's to say, in `intro`), and pastes
 * it in. Stored as the account's credential, the way the gateway's own dashboard adds one.
 */
function TokenPaste(props: { mount: string; provider: GatewayProvider; onSuccess: () => void }) {
  const gateway = gatewayApi(props.mount);
  const copy = props.provider.accountCopy;
  const [token, setToken] = useState("");
  const add = useMutation({
    mutationFn: async () => {
      const result = await gateway.pasteToken(props.provider.id, token.trim());
      if (result?.error) throw new Error(result.error);
      return result;
    },
    onSuccess: props.onSuccess,
  });

  return (
    <div className="border-t border-base-content/10 px-4 py-4 space-y-3 text-xs">
      <Step n={1} title={copy?.title ?? "Get a key for your subscription"}>
        <p className="text-base-content/65 leading-relaxed">
          <Words text={copy?.intro ?? "The provider issues one for your account; it is used instead of an API key."} />
        </p>
      </Step>
      <Step n={2} title={copy?.pasteLabel ?? "Paste it here"}>
        <textarea
          className="textarea w-full font-mono text-[11px] rounded-xl mt-1.5 h-20"
          placeholder={copy?.pastePlaceholder ?? "Paste the key"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
        />
      </Step>
      {add.isError && <p className="text-error flex items-center gap-1.5"><AlertTriangle size={13} /> {(add.error as Error).message}</p>}
      <button
        type="button"
        className="btn btn-sm btn-primary rounded-xl w-full font-semibold"
        disabled={!token.trim() || add.isPending}
        onClick={() => add.mutate()}
      >
        {add.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
        {copy?.button ?? "Connect"}
      </button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="size-5 shrink-0 rounded-full bg-primary/15 text-primary grid place-items-center text-[10px] font-bold">{n}</span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-base-content">{title}</p>
        {children}
      </div>
    </div>
  );
}
