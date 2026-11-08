/**
 * The turns at work, from outside them — the part of the pipeline `/stop` and `/status`, the control API, a mission
 * and the shutdown reach: stop a turn or what it left working in the background, put words in front of one, say what
 * an agent is doing, end a conversation.
 */

import type { MessageEnvelope } from "@nouride/shared";
import type { ModelOverrides } from "@/modules/hooks/registry.ts";
import type { StoppedInBackground } from "@/modules/hooks/types.ts";
import type { PipelineDeps } from "./deps.ts";
import type { TurnContext, ActiveTurn } from "./turn-context.ts";
import type { Voice } from "./voice.ts";
import { agentStatus, type AgentStatus } from "./agent-status.ts";
import { endConversation, type Ended, type EndingConversation, type EndMode } from "./conversation-end.ts";
import { steerReach } from "./steering.ts";

export class TurnControl {
  constructor(
    private readonly o: {
      deps: Pick<
        PipelineDeps,
        | "registry" | "providers" | "jobs" | "externalAgents" | "missionCommands" | "approvals" | "sessions" | "turns"
        | "chatEvents" | "spill" | "notes" | "memory" | "gateways"
      >;
      turnContext: TurnContext;
      voice: Pick<Voice, "outbound">;
      modelOverrides: ModelOverrides;
    },
  ) {}

  /**
   * Cancel whatever this agent is doing in this chat.
   *
   * `/stop` calls it. Without this the command only refused *new* messages, so an agent stuck in a
   * tool loop could not be stopped at all short of restarting the daemon — the reply the operator
   * was waiting on stayed pending and the chat's queue stayed blocked behind it.
   */
  cancelTurnFor(agentId: string, chatId: string): boolean {
    return this.o.turnContext.cancelTurnsForAgent(agentId, chatId) > 0;
  }

  /** Words put in front of an agent's turn at work in a chat — a mission's `tell` (0.8.10, `ActiveTurns.steerInto`). */
  steerInto(agentId: string, chatId: string, gatewayId: string, envelope: MessageEnvelope): "taken" | "full" | "ending" | "none" {
    return this.o.turnContext.steerInto(agentId, chatId, gatewayId, envelope);
  }

  /**
   * How words taken into this agent's turn reach it: at its model's next step; into its coding CLI's running prompt; or,
   * where its CLI takes nothing mid-prompt, once that prompt ends.
   */
  steerReach(agentId: string): "next_step" | "into_cli" | "after_prompt" {
    return steerReach(this.o.deps, agentId);
  }

  /** Where a mission's `tell` its turn was handed is marked read (`ActiveTurns.toldRead`). */
  onToldRead(read: (missionId: string, tellIds: string[]) => void): void {
    this.o.turnContext.toldRead = read;
  }

  cancelTurn(turnKey: string): boolean {
    return this.o.turnContext.cancelTurn(turnKey);
  }

  cancelTurnsInChat(gatewayId: string, chatId: string): number {
    return this.o.turnContext.cancelTurnsInChat(gatewayId, chatId);
  }

  /**
   * Stop what this agent has working in the background for this conversation — its helpers, and the agents it asked
   * whose answers had not come back (0.7.19) — `/stop`'s other half. Each still reports, as stopped.
   */
  stopBackgroundFor(agentId: string, chatId: string): StoppedInBackground {
    const jobs = this.o.deps.jobs;
    const stopped = (jobs?.backgroundTurns(agentId) ?? []).filter((job) => job.chatId === chatId && jobs!.kill(job.id, "/stop"));
    return { helpers: stopped.filter((job) => job.kind === "helper").length, asked: stopped.flatMap((job) => (job.ask ? [job.ask.agent] : [])) };
  }

  /**
   * End one conversation: `/new`, `/reset`, a rollover, or a delete from the dashboard. What each one clears is
   * `ENDS` in `conversation-end.ts`; this is only where its collaborators are — the stores, and this pipeline's own
   * authorship record, model overrides and running turns.
   */
  endConversation(conversation: EndingConversation, mode: EndMode): Promise<Ended> {
    const { deps } = this.o;
    return endConversation(
      {
        sessions: deps.sessions,
        ...(deps.turns ? { turns: deps.turns } : {}),
        ...(deps.chatEvents ? { chatEvents: deps.chatEvents } : {}),
        ...(deps.spill ? { spill: deps.spill } : {}),
        ...(deps.notes ? { notes: deps.notes } : {}),
        approvals: deps.approvals,
        ...(deps.memory ? { memory: deps.memory } : {}),
        authorship: this.o.voice.outbound,
        modelOverrides: this.o.modelOverrides,
        stopTurns: (agentId, chatId) => this.o.turnContext.cancelTurnsForAgent(agentId, chatId),
        forgetCliSession: (agentId, gatewayId, chatId) => deps.externalAgents?.forgetSession?.(agentId, gatewayId, chatId),
        // The connection's own word for its platform; a gateway id is `<platform>:<name>` for one no longer connected.
        platformOf: (gatewayId) => deps.gateways.get(gatewayId)?.platform ?? gatewayId.split(":")[0] ?? gatewayId,
      },
      conversation,
      mode,
    );
  }

  /** Every turn running right now, with its address. Read by the shutdown notice. */
  runningTurns(): ActiveTurn[] {
    return this.o.turnContext.running();
  }

  /** What this agent is doing now — `agent-status.ts`. */
  agentStatus(agentId: string): AgentStatus {
    const { deps } = this.o;
    const agent = deps.registry.get(agentId);
    const provider = agent ? deps.providers.available().find((profile) => profile.name === agent.config.llm.provider) : undefined;
    return agentStatus({
      state: deps.registry.status(agentId),
      enabled: agent?.config.enabled ?? false,
      turns: this.o.turnContext.running().filter((turn) => turn.agentId === agentId),
      // A command its coding CLI left running is work too: Nix's `sleep 30` showed it idle on the sofa (2026-11-03).
      jobs: (deps.jobs?.running(agentId).length ?? 0) + (deps.externalAgents?.working?.().filter((cli) => cli.id === `cli:${agentId}`).length ?? 0),
      missions: deps.missionCommands?.forStatus(agentId) ?? { atWork: 0, waiting: 0 },
      waiting: deps.approvals.pending(agentId).length,
      // An external agent answers on its CLI's sign-in, not its model profile's credential.
      credential: provider && !agent?.config.external ? provider.hasCredential : null,
      cli: agent?.config.external ? (deps.externalAgents?.unavailable?.(agentId) ?? null) : null,
    });
  }
}
