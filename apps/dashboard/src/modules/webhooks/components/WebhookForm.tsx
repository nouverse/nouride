/**
 * Creating a webhook: what it is called, who answers it, and what the call actually does.
 *
 * Its own file because it outgrew the page. It also carries the part of the feature that was hidden:
 * `POST /webhooks` has accepted all three payload kinds since it was written — it shares the parser
 * with `/cron` and even audits `payload_kind` — and this form was the only thing insisting on an
 * agent turn. "Can it just fire a command like cron does" was a field away, not a feature away.
 */

import { useOrchestrator, useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type JobPayloadInput } from "@/commons/lib/api";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { MissionFields, missionDraft, missionPayload } from "@/commons/components/jobs/MissionFields";
import { ChatPicker } from "@/commons/components/jobs/ChatPicker";

export function WebhookForm({
  agents,
  onClose,
  onSaved,
}: {
  agents: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const orchestrator = useOrchestrator();
  const ordered = useOrchestratorFirst(agents, (id) => id);
  const [agentId, setAgentId] = useState(ordered[0] ?? "");
  const [kind, setKind] = useState<WebhookKind>("agentTurn");
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState("");
  const [mission, setMission] = useState(() => missionDraft());
  const gatewayList = useQuery({ queryKey: ["gateways"], queryFn: api.gateways, retry: false });
  const gateways = gatewayList.data?.gateways ?? [];
  const [chosenGateway, setGatewayId] = useState("");
  // The first enabled connection until one is picked, as the Schedule form starts.
  const gatewayId = chosenGateway || (gateways.find((gateway) => gateway.enabled) ?? gateways[0])?.id || "";
  const [chatId, setChatId] = useState("");
  const [announce, setAnnounce] = useState(true);

  /**
   * The payload, in the shape `cronInputFrom` already parses.
   *
   * `POST /webhooks` has accepted all three kinds since it was written — it shares the parser with
   * `/cron` and even audits `payload_kind` — and this form was the only thing insisting on an agent
   * turn. So a webhook that just runs a command was a field away, not a feature away.
   */
  const payload = (): JobPayloadInput =>
    kind === "mission"
      ? missionPayload(mission)
      : kind === "command"
        ? { kind, argv: command.trim().split(/\s+/).filter(Boolean), then: "deliver" }
        : kind === "systemEvent"
          ? { kind, text: message.trim() }
          : { kind, message: message.trim() };

  const save = useMutation({
    mutationFn: () =>
      api.webhookCreate({
        name: name.trim(),
        agentId,
        payload: payload(),
        target: { gatewayId: gatewayId.trim(), chatId: chatId.trim() },
        // A mission's run tells its chat when it is done or needs someone: it always posts there.
        delivery: { mode: announce || kind === "mission" ? "announce" : "none" },
      }),
    onSuccess: onSaved,
  });

  return (
    <Card title="New Webhook" className="border-primary/30 shadow-lg">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" hint="What this webhook is for. Shown in the list and the run log.">
            <input
              className="input w-full rounded-xl text-sm"
              value={name}
              placeholder="CI failures"
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Field>
          <Field label="Agent" hint="Which agent handles the call.">
            <select
              className="select w-full rounded-xl text-sm"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              required
            >
              {ordered.map((id) => (
                <option key={id} value={id}>
                  {id === orchestrator ? `♛ ${id}` : id}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="What the call does"
          hint="The same choices a scheduled job has. Two of them need no model at all."
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {WEBHOOK_KINDS.map((option) => (
              <button
                key={option.kind}
                type="button"
                onClick={() => setKind(option.kind)}
                className={`rounded-xl border p-2.5 text-left transition-all ${
                  kind === option.kind
                    ? "border-primary/40 bg-primary/10"
                    : "border-base-content/[0.08] hover:bg-base-200/60"
                }`}
              >
                <span className="block text-xs font-semibold">{option.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-base-content/65">
                  {option.hint}
                </span>
              </button>
            ))}
          </div>
        </Field>

        {kind === "mission" ? (
          <MissionFields draft={mission} onChange={setMission} />
        ) : kind === "command" ? (
          <Field
            label="Command"
            hint="A command run on this server, with no AI and no approval asked. What the caller sends is not passed to it: a command that read it would be open to anyone holding the address."
          >
            <input
              className="input w-full rounded-xl font-mono text-sm"
              value={command}
              placeholder="systemctl restart my-service"
              onChange={(e) => setCommand(e.target.value)}
              required
            />
          </Field>
        ) : (
          <Field
            label={kind === "systemEvent" ? "Message" : "Instruction"}
            hint={
              kind === "systemEvent"
                ? "Delivered to the chat as written, with what was sent below it. No AI call, so it works even while the AI provider is down."
                : "What the agent should do when this is called. What the caller sends is added below it, marked as not to be trusted. Write it to read what was sent, not to take orders from the caller."
            }
          >
            <textarea
              className="textarea min-h-24 w-full rounded-xl text-sm leading-relaxed"
              value={message}
              placeholder={
                kind === "systemEvent"
                  ? "Something fired the deploy hook."
                  : "A test run failed. Read what was sent, work out which test broke, and say so in one line."
              }
              onChange={(e) => setMessage(e.target.value)}
              required
            />
          </Field>
        )}

        <ChatPicker gateways={gateways} gatewayId={gatewayId} onGateway={setGatewayId} chatId={chatId} onChat={setChatId} />

        <label className={`flex items-start gap-2.5 cursor-pointer ${kind === "mission" ? "hidden" : ""}`}>
          <input
            type="checkbox"
            className="checkbox checkbox-sm mt-0.5"
            checked={announce}
            onChange={(e) => setAnnounce(e.target.checked)}
          />
          <span className="text-sm leading-relaxed">
            {/* Named per mode: two of the three produce no "reply", and the label was the last
                place in this form still assuming an agent turn. */}
            {kind === "agentTurn"
              ? "Post the agent's reply to that chat"
              : kind === "systemEvent"
                ? "Post the message to that chat"
                : "Post the command's output to that chat"}
            <span className="text-base-content/65 block text-xs">
              Off means the run is recorded and nothing is sent. Useful when the job's own tools do
              the work, or when you only want the call logged.
            </span>
          </span>
        </label>

        <ErrorNote error={save.error} />

        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
            disabled={save.isPending}
          >
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            Create Webhook
          </button>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

/**
 * The three things a call can do, in the order that puts the cheap ones first.
 *
 * Copied in spirit from the scheduler's form rather than shared with it: the wording differs because
 * the trigger differs — a webhook's "reminder" is something an external system just did, not a time
 * that came round.
 */
type WebhookKind = JobPayloadInput["kind"];

const WEBHOOK_KINDS: { kind: WebhookKind; label: string; hint: string }[] = [
  {
    kind: "agentTurn",
    label: "Ask the agent",
    hint: "The agent works on it, with its tools. Use it when what to do depends on what is sent.",
  },
  {
    kind: "systemEvent",
    label: "Post a message",
    hint: "Your text and what was sent, straight to the chat. No AI call.",
  },
  {
    kind: "command",
    label: "Run a command",
    hint: "A command run on this server. No AI, no approval asked. Operators only.",
  },
  {
    kind: "mission",
    label: "Start a mission",
    hint: "Long work, checked. What was sent reaches the run's page as data, and the run asks before it sends anywhere new.",
  },
];
