/**
 * Creating and editing a scheduled job.
 *
 * One form for both, because "schedule something" and "change what is scheduled" ask the same five
 * questions and a second implementation of them would answer one of them differently. Until now the
 * dashboard could only answer them for a job that already existed — every job on a live daemon had to
 * be created from the CLI or by asking an agent to do it, which is a strange gap on the page whose
 * whole subject is scheduled work.
 *
 * The five questions, in the order somebody actually thinks about them:
 *
 *   1. what should happen        a reminder, an agent turn, or a command
 *   2. when                      an interval, a time of day, a cron expression, or once
 *   3. where it goes             which conversation, and whether to say anything at all
 *   4. what it remembers         the history mode — see `session`
 *   5. who runs it               which agent
 *
 * Nothing here parses a schedule. `every`, `cron` and `at` go to the daemon as the strings it already
 * validates and refuses; a browser-side cron parser would be a second opinion about which
 * expressions are legal, and the two would disagree on the day one of them was fixed.
 */

import { useOrchestrator, useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Clock, Target, Terminal, Zap } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentSummary, GatewayInstance, JobPatch, JobPayloadInput, JobSummary, SessionSummary } from "@nouride/wire";
import { ErrorNote, Field } from "@/commons/components/ui/ui";
import { ChatPicker } from "@/commons/components/jobs/ChatPicker";
import { MissionFields, missionDraft, missionPayload } from "@/commons/components/jobs/MissionFields";
import { Choice, Section } from "./form-parts";
import { TriggerFields } from "./TriggerFields";
import { draftFromTrigger, triggerBody, type TriggerDraft } from "../lib/trigger";

type PayloadKind = Exclude<JobPayloadInput["kind"], "steps">;
/** What a command's output is worth: posted as it is, or handed to one turn. */
type Then = Extract<JobPayloadInput, { kind: "command" }>["then"];
type SessionMode = JobSummary["session"];

const PAYLOADS: { kind: PayloadKind; label: string; hint: string; icon: typeof Clock }[] = [
  {
    kind: "systemEvent",
    label: "Reminder",
    hint: "Text delivered as written. No model call at all, so it still works while the provider is down.",
    icon: Clock,
  },
  {
    kind: "agentTurn",
    label: "Ask the agent",
    hint: "A full turn with tools. The expensive one: use it when the answer is not known yet.",
    icon: Zap,
  },
  {
    kind: "command",
    label: "Run a command",
    hint: "A command run on this server, with no AI and no approval asked. Operators only.",
    icon: Terminal,
  },
  {
    kind: "mission",
    label: "Mission",
    hint: "Long work, checked: each run survives a restart, asks when it needs you, and is reviewed before it counts as done.",
    icon: Target,
  },
];

/**
 * The three history modes, written for somebody deciding rather than somebody who already knows.
 *
 * Ordered cheapest first, which is also most-likely-correct first. `chat` is last and says what it
 * costs: it was the old default, and on a live box it had grown one Discord channel's session to 24k
 * tokens of daily reports interleaved with people talking.
 */
const SESSIONS: { mode: SessionMode; label: string; hint: string }[] = [
  {
    mode: "fresh",
    label: "Nothing",
    hint: "Each run starts clean. Cheapest, and right for anything that reports: a daily summary gains nothing from remembering yesterday's.",
  },
  {
    mode: "isolated",
    label: "Its own history",
    hint: "Private to this job, kept between runs, never in anyone's transcript. For a job that builds on where it left off.",
  },
  {
    mode: "chat",
    label: "The conversation's",
    hint: "Reads and appends to the target chat. The job sees what people said there, and their next message carries its output. Choose it only for a job that is part of the discussion.",
  },
];

export function JobForm({
  job,
  timezone,
  agents,
  gateways,
  chats,
  onDone,
  onCancel,
}: {
  /** Absent for a new job. Present means editing that one. */
  job?: JobSummary;
  timezone: string;
  agents: AgentSummary[];
  gateways: GatewayInstance[];
  /** Recent conversations, so the chat id can be picked instead of pasted. */
  chats: SessionSummary[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const editing = Boolean(job);

  const [name, setName] = useState(job?.name ?? "");
  const orchestrator = useOrchestrator();
  const ordered = useOrchestratorFirst(agents, (agent) => agent.id);
  const [agentId, setAgentId] = useState(job?.agentId ?? ordered[0]?.id ?? "");
  const [kind, setKind] = useState<PayloadKind>(job && job.payload.kind !== "steps" ? job.payload.kind : "agentTurn");

  const [text, setText] = useState(String(job?.payload.text ?? ""));
  const [message, setMessage] = useState(String(job?.payload.message ?? ""));
  const [command, setCommand] = useState(shellLineOf(job));
  const [then, setThen] = useState<Then>(job?.payload.then === "agentTurn" ? "agentTurn" : "deliver");
  const [mission, setMission] = useState(() => missionDraft(job?.payload));
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    typeof job?.payload.timeoutMs === "number" ? String(job.payload.timeoutMs / 1000) : "",
  );

  const [trigger, setTrigger] = useState<TriggerDraft>(() =>
    draftFromTrigger(job?.trigger, timezone),
  );
  const patchTrigger = (patch: Partial<TriggerDraft>) => setTrigger((t) => ({ ...t, ...patch }));

  const [gatewayId, setGatewayId] = useState(
    job?.target.gatewayId ?? gateways.find((g) => g.enabled)?.id ?? gateways[0]?.id ?? "",
  );
  const [chatId, setChatId] = useState(job?.target.chatId ?? "");
  const [deliveryMode, setDeliveryMode] = useState(job?.delivery.mode ?? "announce");
  // Defaulting to `fresh` for a new job matches the daemon. It is the answer that cannot surprise
  // somebody with a bill or with a scheduled report appearing inside a human conversation.
  const [session, setSession] = useState<SessionMode>(job?.session ?? "fresh");
  const [keepAfterRun, setKeepAfterRun] = useState(false);

  const payload = (): JobPayloadInput => {
    if (kind === "systemEvent") return { kind, text: text.trim() };
    if (kind === "agentTurn") return { kind, message: message.trim() };
    if (kind === "mission") return missionPayload(mission);
    const line = command.trim();
    return {
      kind,
      // `sh -lc` because somebody typing into this box means a shell line, not an argv. The agent
      // reaching the same argv meets a hardline gate; an operator here is the operator.
      argv: line ? ["sh", "-lc", line] : [],
      then,
      ...(timeoutSeconds ? { timeoutMs: Math.round(Number(timeoutSeconds) * 1000) } : {}),
    };
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        payload: payload(),
        ...triggerBody(trigger),
        target: { gatewayId, chatId: chatId.trim() },
        // A mission's run tells its chat when it is done or needs someone: it always posts there.
        delivery: { mode: kind === "mission" ? "announce" : deliveryMode },
        session,
      } satisfies JobPatch;
      // The agent is chosen when the job is made and not sent on an edit: this form has no control
      // that moves a job to another agent, and a patch that named one would.
      if (editing) return api.cronUpdate(job!.id, body);
      return api.cronCreate({ ...body, agentId, keepAfterRun });
    },
    onSuccess: onDone,
  });

  const scheduled = Object.keys(triggerBody(trigger)).length > 0;
  const hasPayload =
    kind === "systemEvent" ? text.trim() : kind === "agentTurn" ? message.trim() : kind === "mission" ? mission.goal.trim() : command.trim();
  const ready = name.trim() && agentId && chatId.trim() && scheduled && hasPayload;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" hint="What this shows up as in the list and in a failure alert.">
          <input
            className="input input-sm w-full rounded-xl"
            value={name}
            placeholder="e.g. morning server report"
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field
          label="Agent"
          hint={editing ? "Fixed once created. Delete and recreate to move it." : "Whose personality and tools it runs with."}
        >
          <select
            className="select select-sm w-full rounded-xl"
            value={agentId}
            disabled={editing}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {ordered.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.id === orchestrator ? "♛ " : ""}{agent.displayName} ({agent.id})
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* ── 1. What happens ────────────────────────────────────────────── */}
      <Section title="What should happen">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PAYLOADS.map((entry) => (
            <Choice
              key={entry.kind}
              selected={kind === entry.kind}
              label={entry.label}
              hint={entry.hint}
              icon={entry.icon}
              // Changing the kind on an existing job is allowed — it is one field of the patch — but
              // the boxes for the other kinds keep their text, so switching back loses nothing.
              onClick={() => setKind(entry.kind)}
            />
          ))}
        </div>

        {kind === "systemEvent" && (
          <Field label="Message" hint="Delivered exactly as written.">
            <input
              className="input input-sm w-full rounded-xl"
              value={text}
              placeholder="e.g. Jemput Sam jam 5"
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
        )}

        {kind === "agentTurn" && (
          <Field label="Prompt" hint="What the agent is woken with. It runs with its tools, unattended.">
            <textarea
              className="textarea textarea-sm w-full rounded-xl font-mono text-xs"
              rows={3}
              value={message}
              placeholder="Check how things are running and report anything wrong."
              onChange={(e) => setMessage(e.target.value)}
            />
          </Field>
        )}

        {kind === "command" && (
          <div className="space-y-3">
            <Field label="Command" hint="Runs on this server, as Nouride's own user.">
              <input
                className="input input-sm w-full rounded-xl font-mono text-xs"
                value={command}
                placeholder="scripts/check-queue.sh" // plain-words-ok: an example of the command this field takes
                onChange={(e) => setCommand(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="After it runs" hint="What its output is worth.">
                <select
                  className="select select-sm w-full rounded-xl"
                  value={then}
                  onChange={(e) => setThen(e.target.value as Then)}
                >
                  <option value="deliver">Post the output as it is (no AI call)</option>
                  <option value="agentTurn">Hand the output to one agent turn</option>
                </select>
              </Field>
              <Field label="Timeout (seconds)" hint="Empty means the default limit.">
                <input
                  className="input input-sm w-full rounded-xl font-mono"
                  type="number"
                  min={1}
                  value={timeoutSeconds}
                  placeholder="600"
                  onChange={(e) => setTimeoutSeconds(e.target.value)}
                />
              </Field>
            </div>
          </div>
        )}
        {kind === "mission" && <MissionFields draft={mission} onChange={setMission} />}
      </Section>

      <TriggerFields
        trigger={trigger}
        onChange={patchTrigger}
        keepAfterRun={editing ? null : keepAfterRun}
        onKeepAfterRun={setKeepAfterRun}
      />

      {/* ── 3. Where it goes ───────────────────────────────────────────── */}
      <Section title="Where it goes">
        <ChatPicker gateways={gateways} gatewayId={gatewayId} onGateway={setGatewayId} chatId={chatId} onChat={setChatId} recent={chats} />
        <Field label="Say something?" hint={kind === "mission" ? "A mission tells that chat when a run is done or needs someone." : "A run is recorded either way."}>
          <select
            className="select select-sm w-full rounded-xl"
            disabled={kind === "mission"}
            value={kind === "mission" ? "announce" : deliveryMode}
            onChange={(e) => setDeliveryMode(e.target.value as typeof deliveryMode)}
          >
            <option value="announce">Post the result to that chat</option>
            <option value="none">Say nothing, run silently</option>
            <option value="webhook">POST it to a webhook</option>
          </select>
        </Field>
      </Section>

      {/* ── 4. What it remembers — a mission's every turn starts from its own page instead ─ */}
      {kind !== "mission" && <Section title="What it remembers between runs">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {SESSIONS.map((entry) => (
            <Choice
              key={entry.mode}
              selected={session === entry.mode}
              label={entry.label}
              hint={entry.hint}
              onClick={() => setSession(entry.mode)}
            />
          ))}
        </div>
      </Section>}

      <ErrorNote error={save.error} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
          disabled={!ready || save.isPending}
        >
          {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
          {editing ? "Save changes" : "Schedule it"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onCancel}>
          Cancel
        </button>
        {!ready && (
          <span className="text-[11px] text-base-content/65">
            Needs a name, a chat, a schedule and something to do.
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * The stored argv as a shell line again.
 *
 * `sh -lc "<line>"` is what this form writes, so it is what it reads back. An argv that came from
 * somewhere else — the CLI, an agent — is joined with spaces, which is lossy for arguments containing
 * them; that is visible in the box rather than silent, and editing it rewrites it as a shell line.
 */
function shellLineOf(job?: JobSummary): string {
  const argv = job?.payload.argv;
  if (!Array.isArray(argv)) return "";
  const parts = argv.map(String);
  if (parts[0] === "sh" && parts[1] === "-lc" && parts.length === 3) return parts[2]!;
  return parts.join(" ");
}
