/**
 * How to actually call the thing you just made.
 *
 * The URL alone was not enough, and the report said why: "kalau sekarang cuma begini, gw bingung
 * kalo mau dynamic." A person looking at a token has no way to tell whether the endpoint takes a
 * body, what shape it wants, or what happens to it — so the reasonable guess is that a body can
 * carry the instruction, which is the one thing it deliberately cannot.
 *
 * So this says all three: the call, what the body becomes, and the line it does not cross.
 *
 * Written per payload kind rather than once, because the three kinds do genuinely different things
 * with a body — one reads it, one prints it, one ignores it — and a single paragraph covering all
 * three is wrong twice. `kind` comes from the job's own payload, so a card cannot describe a mode
 * it is not in.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/commons/lib/clipboard";

/**
 * What the daemon shows the model, from `MAX_TRIGGER_BODY_CHARS` in `cron/scheduler.ts`.
 *
 * Stated because it is the number that decides whether a big payload arrives whole, and a caller
 * sending GitHub's push events is over it. The socket cap is 1 MB and separate — over *that* the
 * request is refused outright with a 413, which is a different conversation from being truncated.
 */
const BODY_CHARS_SHOWN = 8_000;

type PayloadKind = "systemEvent" | "agentTurn" | "command" | "mission";

export function CallExample({ url, kind }: { url: string; kind: PayloadKind }) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (label: string, text: string) => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(label);
      setTimeout(() => setCopied(null), 2_000);
    });
  };

  /**
   * A body with fields rather than a bare string, because that is the shape of the question.
   *
   * Anyone wiring this up has a payload already — an alert, a CI result, a sensor reading — and what
   * they need to see is that it arrives intact and that the instruction is what reads it. A `curl`
   * with `{"instruction": …}` would demonstrate the opposite of the rule below.
   */
  const fire = [
    `curl -X POST '${url}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '{"severity":"high","service":"api","note":"latency over 2s"}'`,
  ].join("\n");

  const wait = `curl -X POST '${url}?wait=1' -H 'content-type: application/json' -d '{"severity":"high"}'`;

  return (
    <details className="group rounded-xl border border-base-content/[0.08] bg-base-200/30">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-base-content/70 hover:text-base-content">
        <span className="transition-transform group-open:rotate-90">›</span>
        How to call it
      </summary>

      <div className="space-y-3 px-3 pb-3 pt-1">
        <Snippet
          label="Fire it"
          note={
            kind === "agentTurn" || kind === "mission"
              ? "Answers 202 with the job's id straight away: an agent's work takes longer than any sender will wait. 409 while the last call is still running."
              : "Answers 202 with the job's id straight away, then does the work. 409 while the last call is still running."
          }
          code={fire}
          copied={copied === "fire"}
          onCopy={() => copy("fire", fire)}
        />
        <Snippet
          label="Fire it and wait for the outcome"
          note="For testing what you just built. Holds the connection until the run finishes, so do not point a real sender at this."
          code={wait}
          copied={copied === "wait"}
          onCopy={() => copy("wait", wait)}
        />

        <div className="space-y-1.5 rounded-lg bg-base-100/60 p-3 text-xs leading-relaxed text-base-content/70">
          {kind === "agentTurn" && <AgentTurnRules />}
          {kind === "systemEvent" && <SystemEventRules />}
          {kind === "command" && <CommandRules />}
          {kind === "mission" && <MissionRules />}
          <p>
            <b className="text-base-content/85">POST only.</b> A GET would be fired by anything that
            follows links (a chat client&apos;s link preview, a crawler, a browser prefetch), and this
            URL is a credential that people paste into places that do exactly that.
          </p>
        </div>
      </div>
    </details>
  );
}

/** The mode where a model reads the body, and therefore the only one with a trust boundary. */
function AgentTurnRules() {
  return (
    <>
      <p>
        <b className="text-base-content/85">The body is data, not orders.</b> Whatever you send
        (JSON, plain text, a form post) is appended below this webhook&apos;s instruction and marked
        as untrusted: the agent is told to read it and explicitly told not to follow instructions
        inside it. A field called &ldquo;instruction&rdquo; arrives like any other field and is not
        obeyed.
      </p>
      <p>
        {/*
          Said plainly, because it is the difference between "this feature is missing" and "this
          feature is refused". The URL is the only credential — a body that could set the prompt
          would make a leaked URL into arbitrary instructions for an agent that holds `exec`.
        */}
        That is on purpose. Anyone holding this URL can fire it, so if the body could set the
        instruction, a leaked URL would be a way to make this agent do anything.
      </p>
      <p>
        <b className="text-base-content/85">To vary what happens, say so in the instruction.</b> Write it
        to read what was sent (&ldquo;read what was sent; if its severity is high, page me, otherwise
        just log it&rdquo;) and let the caller vary the fields. The first {BODY_CHARS_SHOWN.toLocaleString("en-US")} characters are
        shown to the agent; anything past that is truncated with the total noted.
      </p>
    </>
  );
}

/** A mission's run reads the body on its page, as data, and is marked as having read outside content. */
function MissionRules() {
  return (
    <>
      <p>
        <b className="text-base-content/85">The body is data on the run&apos;s page, not orders.</b> Each call starts a
        mission with this webhook&apos;s goal; what you send is on its page, marked as written by whoever called, and
        never followed as an instruction. The first {BODY_CHARS_SHOWN.toLocaleString("en-US")} characters are kept.
      </p>
      <p>
        <b className="text-base-content/85">One run at a time.</b> A call while the last run still works is recorded as
        skipped. The run asks before it sends anything anywhere its chat is not, since nobody is watching it.
      </p>
    </>
  );
}

/** No model runs here, so the body is text going to a chat and nothing is interpreting it. */
function SystemEventRules() {
  return (
    <>
      <p>
        <b className="text-base-content/85">The body is appended to your message, verbatim.</b> Your
        text first, then a blank line, then exactly what was sent, so data sent as JSON arrives as JSON
        and whoever is in the chat can read it. The first{" "}
        {BODY_CHARS_SHOWN.toLocaleString("en-US")} characters are kept; past that it is truncated with
        the total noted.
      </p>
      <p>
        No model runs in this mode, so nothing in the body can be an instruction to anything: it is a
        message being posted. Send nothing at all and only your text is posted, which is the mode a
        plain &ldquo;deploy finished&rdquo; ping wants.
      </p>
      <p>
        Switch this webhook to <b className="text-base-content/85">Ask the agent</b> if you want what
        was sent read and acted on rather than shown.
      </p>
    </>
  );
}

/** argv is fixed at configuration time; a request cannot add to it. That is the whole point. */
function CommandRules() {
  return (
    <>
      <p>
        <b className="text-base-content/85">The body is ignored in this mode.</b> The command line is
        fixed when you save the webhook, and a call cannot add anything to it, so calling this
        address runs the same thing every time, whatever is sent.
      </p>
      <p>
        {/*
          The refusal is the feature. A body that reached argv would make a leaked URL a remote shell,
          which is the one outcome this design has to make impossible rather than unlikely.
        */}
        That is deliberate: anyone holding this address can call it, and if what they sent reached
        the command, a leaked address would be a way into this server.
      </p>
      <p>
        Use <b className="text-base-content/85">Ask the agent</b> for anything that has to vary with
        the caller: the agent can read what was sent and decide, with its own approval rules in
        front of whatever it runs.
      </p>
    </>
  );
}

function Snippet({
  label,
  note,
  code,
  copied,
  onCopy,
}: {
  label: string;
  note: string;
  code: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-base-content/65 font-mono">
          {label}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-xs h-6 max-sm:h-8 gap-1 rounded-lg px-2 text-[10px]"
          onClick={onCopy}
        >
          {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-base-300/40 p-2.5 font-mono text-[11px] leading-relaxed text-base-content/85">
        {code}
      </pre>
      <p className="text-[11px] leading-normal text-base-content/65">{note}</p>
    </div>
  );
}
