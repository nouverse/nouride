/**
 * A coding CLI's sign-in, run on the box (0.8.1): the steps while it runs — open the link, sign in, paste the code back
 * — with its terminal, since a CLI may ask a question there. Once it signed in it has little left to say: the caller's
 * own line (an account's row, a profile's) says it. One that did not keeps its terminal, which says why.
 *
 * Enter alone is a button: a terminal UI that turned a code down says "Press Enter to retry", and the field sends
 * nothing empty (0.8.8). What was sent is said under the field, with what to do when the terminal does not move on.
 *
 * Shared by an agent's Brain tab (its own sign-in) and the Models page (an account's, shared by its agents).
 */

import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { CheckCircle2, CornerDownLeft, ExternalLink, KeyRound, Send, Square } from "lucide-react";
import type { CliLoginView } from "@nouride/wire";
import { ErrorNote } from "@/commons/components/ui/ui";

export function CliSignIn(props: {
  /** What it signs in, as a sentence names it: "profile work", "account team". */
  what: string;
  cliName: string;
  admin: boolean;
  login: CliLoginView;
  answer: (text: string) => Promise<unknown>;
  stop: () => Promise<unknown>;
  onChanged: () => void;
  /** Said beside "… is signed in" — an offer to use it; omitted, a sign-in that worked shows nothing. */
  done?: ReactNode;
}) {
  const { what, cliName, admin, login } = props;
  const [answer, setAnswer] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  // Enter alone leaves the field as it was: a code pasted there and sent with Enter instead of Send was lost (Nox).
  const send = useMutation({ mutationFn: props.answer, onSuccess: (_, text) => { if (text) setAnswer(""); setSent(text ? "Sent" : "Sent Enter"); props.onChanged(); } });
  const stop = useMutation({ mutationFn: props.stop, onSuccess: props.onChanged });
  const signedIn = login.signedIn;
  const transcript = <pre className="bg-base-200 rounded-xl p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-72 overflow-auto">{login.output || "…"}</pre>;

  if (!login.running) {
    // On the live box a finished sign-in still showed its whole terminal under "Signed in".
    if (signedIn && !props.done) return null;
    return (
      <div className="space-y-2 rounded-xl border border-base-content/10 p-3">
        {signedIn ? (
          <p className="text-success flex flex-wrap items-center gap-2 text-xs">
            <CheckCircle2 size={14} aria-hidden="true" /> The {what} is signed in. {props.done}
          </p>
        ) : login.stopped ? (
          <p className="text-base-content/70 flex items-center gap-2 text-xs"><Square size={14} aria-hidden="true" /> The sign-in for the {what} was stopped before it signed in.</p>
        ) : (
          <p className="text-warning flex items-center gap-2 text-xs"><KeyRound size={14} aria-hidden="true" /> The sign-in for the {what} ended without signing in (exit {login.exitCode}).</p>
        )}
        {signedIn ? null : (
          <details className="text-xs" open>
            <summary className="text-base-content/65 cursor-pointer">What the sign-in printed</summary>
            <div className="mt-2">{transcript}</div>
          </details>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <p className="text-sm font-semibold">Signing in the {what}</p>
      <ol className="text-base-content/75 list-decimal space-y-1 pl-5 text-xs">
        <li>Open the sign-in page{login.links.length === 0 ? " when it appears below" : ""}.</li>
        <li>Sign in with the {cliName} account it should use.</li>
        <li>Paste back the code it gives you, or, if the browser ends on a page that does not load, that page's address.</li>
      </ol>
      {login.links.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {/* Named, not the address: a sign-in's is a few hundred characters, and the terminal below shows it whole. */}
          {login.links.map((link, index) => (
            <a key={link} href={link} target="_blank" rel="noreferrer" title={link} className="btn btn-sm btn-primary gap-2">
              <ExternalLink size={14} aria-hidden="true" /> {index === 0 ? "Open the sign-in page" : `Open link ${index + 1}`}
            </a>
          ))}
        </div>
      ) : null}
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) send.mutate(answer.trim()); }}>
        <input className="input input-sm w-full font-mono rounded-xl" value={answer} placeholder="The code, or the address the browser ended on" onChange={(event) => setAnswer(event.target.value)} disabled={!admin} autoComplete="off" />
        <button type="submit" className="btn btn-sm btn-primary gap-1" disabled={!admin || !answer.trim() || send.isPending}><Send size={14} aria-hidden="true" /> Send</button>
        <button type="button" className="btn btn-sm btn-ghost gap-1" disabled={!admin || send.isPending} onClick={() => send.mutate("")} title="Press Enter in the terminal when it says to"><CornerDownLeft size={14} aria-hidden="true" /> Enter</button>
        <button type="button" className="btn btn-sm btn-ghost gap-1" disabled={!admin} onClick={() => stop.mutate()}><Square size={14} aria-hidden="true" /> Stop</button>
      </form>
      {sent ? <p className="text-base-content/65 text-xs">{sent}. The terminal below shows what {cliName} does with it. If it does not move on within a minute, Stop and sign in again.</p> : null}
      {transcript}
      <ErrorNote error={send.error ?? stop.error} />
    </div>
  );
}
