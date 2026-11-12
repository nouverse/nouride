/**
 * The slash commands — the part of the pipeline a person's `/command` reaches: the hook registry, handed what each
 * command acts on. The hooks themselves are `modules/hooks/`; this is what they are given of the pipeline.
 */

import type { LoadedAgent, MessageEnvelope } from "@nouride/shared";
import { HookRegistry, type ModelOverrides } from "@/modules/hooks/registry.ts";
import type { DaemonRestart } from "@/modules/update/restart.ts";
import type { PipelineDeps } from "./deps.ts";
import type { Admission } from "./admission.ts";
import type { TurnContext } from "./turn-context.ts";
import type { SessionLifecycle } from "./session-lifecycle.ts";
import type { SideQuestions } from "./side-question.ts";
import type { TurnControl } from "./turn-control.ts";
import { renderPromptForOperator } from "./render-prompt.ts";
import { secretsHookPort, type ChatSecrets } from "./chat-secrets.ts";
import { groupMentionHookPort } from "./room-mention.ts";

export function slashCommands(parts: {
  deps: Pick<
    PipelineDeps,
    | "registry" | "sessions" | "approvals" | "notes" | "missionCommands" | "scheduleCommands" | "grants" | "startedAt"
    | "version" | "externalAgents" | "agentEffort" | "autoApprove" | "config" | "gateways" | "usage" | "reflection"
    | "roomMention" | "rooms" | "secretKeeping"
  >;
  admission: Pick<Admission, "admitsByName" | "claim">;
  modelOverrides: ModelOverrides;
  /** For `/prompt`, which renders the prompt a turn here would be sent. */
  turnContext: TurnContext;
  lifecycle: Pick<SessionLifecycle, "compactSession">;
  sideQuestions: Pick<SideQuestions, "ask">;
  /** The credentials people send, for `/secret`. Absent, the command is not offered. */
  secrets: ChatSecrets | undefined;
  /** `/stop`, `/status`, `/new` and `/reset`: what a command does to the turns and the conversation. */
  control: Pick<TurnControl, "cancelTurnFor" | "stopBackgroundFor" | "agentStatus" | "endConversation">;
  isAdmin: (envelope: MessageEnvelope) => boolean;
  /** The daemon's restart, handed to the pipeline once built: `/daemon-restart` reads it when it is typed. */
  restart: () => DaemonRestart | undefined;
  /** A message put back — `/secret undo` — arriving as one from its platform would. */
  deliver: (envelope: MessageEnvelope) => void;
  /** For `/mention`: what each agent is tagged with on a platform, and who answers an untagged message in a room. */
  mentionTags: (platform: MessageEnvelope["gateway"]) => Record<string, string>;
  untaggedAnswerer: (room: { gateway: MessageEnvelope["gateway"]; gatewayId: string; chatId: string }) => string | null;
}): HookRegistry {
  const { deps, admission, modelOverrides, isAdmin, control } = parts;
  // Those a person may change only by name and as an admin: a restart, an agent's effort, a group's mention rule, secrets.
  const mayChange = (envelope: MessageEnvelope) => admission.admitsByName(envelope) && isAdmin(envelope);
  const hooks: HookRegistry = new HookRegistry({
    registry: deps.registry,
    restart: {
      request: (request) => parts.restart()?.request(request) ?? null,
      mayRestart: mayChange,
    },
    isAdmin,
    sessions: deps.sessions,
    approvals: deps.approvals,
    modelOverrides,
    endConversation: (conversation, mode) => control.endConversation(conversation, mode),
    ...(deps.notes ? { notes: deps.notes } : {}),
    ...(deps.missionCommands ? { missions: deps.missionCommands } : {}),
    ...(deps.scheduleCommands ? { proposals: deps.scheduleCommands } : {}),
    ...(deps.grants ? { grants: deps.grants } : {}),
    daemon: { startedAt: deps.startedAt, version: deps.version },
    // The redacted text — the operator's own files, with everything this repository wrote
    // replaced by a note. See `renderPromptForOperator`.
    renderPrompt: (id, c) => renderPromptForOperator(parts.turnContext, hooks, modelOverrides, id, c.envelope),
    cancelTurn: (agentId, chatId) => control.cancelTurnFor(agentId, chatId),
    stopBackground: (agentId, chatId) => control.stopBackgroundFor(agentId, chatId),
    agentStatus: (agentId) => control.agentStatus(agentId),
    ...(deps.externalAgents?.offeredEfforts ? { cliEfforts: (agentId: string) => deps.externalAgents!.offeredEfforts!(agentId) } : {}),
    ...(deps.agentEffort ? { agentEffort: { mayChange, set: deps.agentEffort } } : {}),
    ...(deps.externalAgents?.answering ? { answering: (agent: LoadedAgent, gatewayId: string, chatId: string) => deps.externalAgents!.answering!(agent, gatewayId, chatId) } : {}),
    compactSession: (agentId, hookCtx) => parts.lifecycle.compactSession(agentId, hookCtx),
    sideQuestion: (agent, envelope, question) => parts.sideQuestions.ask(agent, envelope, question),
    ...(deps.autoApprove ? { autoApprove: deps.autoApprove } : {}),
    // So `/approvals` can report the fallback when neither the agent nor the person has set one.
    daemonApprovals: deps.config.security.approvals,
    resolveGateway: (id) => deps.gateways.get(id),
    listHooks: () => hooks.list(),
    ...(deps.usage ? { sessionUsage: (sessionId: string, since: number, onlyCli?: boolean) => deps.usage!.forSession(sessionId, since, onlyCli) } : {}),
    ...(deps.reflection ? { drafts: deps.reflection } : {}),
    ...(deps.roomMention
      ? {
          groupMention: groupMentionHookPort({
            config: deps.config,
            store: deps.roomMention,
            ...(deps.rooms ? { rooms: deps.rooms } : {}),
            mayChange,
            claim: (envelope, key) => admission.claim(envelope, key),
            agents: () => deps.registry.enabled().map((agent) => ({ id: agent.config.id, name: agent.config.displayName || agent.config.id })),
            tags: parts.mentionTags,
            answers: (envelope) => parts.untaggedAnswerer({ gateway: envelope.gateway, gatewayId: envelope.gatewayId, chatId: envelope.chatId }),
          }),
        }
      : {}),
    ...(parts.secrets
      ? { secrets: secretsHookPort({ secrets: parts.secrets, keeping: deps.secretKeeping, registry: deps.registry, mayManage: mayChange, deliver: parts.deliver }) }
      : {}),
  });
  return hooks;
}

/**
 * The slash commands a person may type, for a client that wants to offer them.
 *
 * The same list Telegram's menu is built from, from the same registry — because a command list
 * typed out a second time is a command list that goes stale, which is exactly how `/auto` went on
 * being advertised for a release after it became `/approvals`. Hidden commands stay hidden: they
 * answer, they are not taught.
 */
export function commandMenu(hooks: Pick<HookRegistry, "list">): { command: string; description: string }[] {
  return hooks
    .list()
    .filter((hook) => !hook.hidden)
    .map((hook) => ({ command: hook.command, description: hook.description }));
}
