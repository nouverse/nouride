/**
 * Whether a group's unaddressed message may be answered at all — `groups_require_mention` — and the command a group
 * sets it with, `/mention` (`hooks/builtins/mention.ts`).
 *
 * Three places can say it, and the nearest wins: the group itself (`room-mention.store.ts`), the connection
 * (`[gateways.<platform>.<name>] groups_require_mention`), the daemon (`[agents] groups_require_mention`). A group with
 * no row of its own is decided exactly as before the row could exist.
 *
 * `/mention` is about the group, not about an agent, and that changes how it has to arrive. Every one of our bots in
 * the group is handed its own copy, and in a room several of them share an untagged message reaches nobody
 * (`answerUnaddressed`, `inbound.ts`) — so the one command that changes the tagging rule would itself need a tag. It
 * is answered before routing instead (`answerGroupCommand`), and once: whichever copy comes first takes it
 * (`firstCopy`). It is answered by the orchestrator, through its own bot, so a group hears one voice whichever bot's
 * copy came first — on a live group `/mention` was answered by Nouva's bot and `/mention off` by Nestor's (0.7.18).
 */

import type { AgentRegistry } from "@nouride/persona";
import type { GlobalConfig, LoadedAgent, MessageEnvelope } from "@nouride/shared";
import type { HookRegistry } from "@/modules/hooks/registry.ts";
import type { GroupMentionHookPort, MentionSource } from "@/modules/hooks/types.ts";
import { parseCommand } from "@/modules/hooks/parse.ts";
import { isEdit } from "./edit-rules.ts";
import { isSystemEvent } from "./deps.ts";
import type { RoomMentionPort } from "./room-mention.store.ts";

interface Sources {
  config: Pick<GlobalConfig, "agents" | "gateways">;
  roomMention?: Pick<RoomMentionPort, "get">;
}

/**
 * Does an unaddressed message in this chat need a mention, and who said so.
 *
 * Keyed by the room as the platform sees it — `envelope.gateway` is the platform, not our connection — so every bot in
 * the group reads the same answer. The connection is the one the message arrived on.
 */
export function requireMentionHere(
  sources: Sources,
  envelope: Pick<MessageEnvelope, "gateway" | "gatewayId" | "chatId">,
): { requireMention: boolean; source: MentionSource } {
  const own = sources.roomMention?.get(envelope.gateway, envelope.chatId);
  if (own) return { requireMention: own.requireMention, source: "group" };
  const instance = sources.config.gateways.find((gateway) => gateway.id === envelope.gatewayId)?.groupsRequireMention;
  if (instance !== undefined) return { requireMention: instance, source: "gateway" };
  return { requireMention: sources.config.agents.groupsRequireMention ?? false, source: "daemon" };
}

/**
 * What `/mention` is handed: the store, the precedence above, who may change it, and the once-per-group claim.
 *
 * `claim` is the pipeline's one-turn-per-message table (`Admission.claim`), keyed here on what every copy of one
 * message shares. Where each bot numbers a message its own way (`idsPerConnection`, a Telegram group) the id differs
 * per copy, so the key is who sent it and when — the platform stamps every copy with the same time.
 */
export function groupMentionHookPort(o: {
  config: Sources["config"];
  store: RoomMentionPort;
  mayChange: (envelope: MessageEnvelope) => boolean;
  claim: (envelope: MessageEnvelope, key: string) => boolean;
}): GroupMentionHookPort {
  return {
    here: (envelope) => requireMentionHere({ config: o.config, roomMention: o.store }, envelope),
    set: (envelope, requireMention, actor) =>
      requireMention === null
        ? o.store.clear(envelope.gateway, envelope.chatId)
        : (o.store.set(envelope.gateway, envelope.chatId, requireMention, actor), true),
    mayChange: o.mayChange,
    firstCopy: (envelope, command) => {
      const said = envelope.idsPerConnection ? `${envelope.senderId}@${envelope.timestamp}` : envelope.id;
      return o.claim({ ...envelope, id: said }, command);
    },
  };
}

/**
 * How long another bot's copy of a group command waits, so the orchestrator's own copy is the one that answers. Its
 * bot may not be in the group — nothing says which groups a bot was invited to — so after this the copy that came
 * first answers anyway, through the orchestrator's bot or, where that cannot send here, its own.
 */
const DESK_FIRST_MS = 1_500;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Answer a command about the group before anyone is routed. True when it was one.
 *
 * Not one: an edit (words, never a command — `edits.ts`), a bot's message, the daemon's own events, and a command
 * still carrying another bot's name (`/mention@otherbot`). Our own bot's name is taken off by the adapter, so a suffix
 * left here is somebody else's — that bot's own copy is the one to answer it.
 *
 * Run as the orchestrator and spoken through its bot where it has one (`Voice.reply`), else as the connection's own
 * agent or the first enabled one: the hook needs an agent to run as, and a group command says nothing about which.
 */
export async function answerGroupCommand(
  o: {
    hooks: HookRegistry;
    registry: AgentRegistry;
    config: Pick<GlobalConfig, "gateways" | "daemon">;
    reply: (envelope: MessageEnvelope, text: string, fromAgent: string) => Promise<unknown>;
    /** Whether a connection is up — another bot's copy waits for the orchestrator's only when its bot can answer. */
    connected: (gatewayId: string) => boolean;
    wait?: (ms: number) => Promise<void>;
  },
  envelope: MessageEnvelope,
): Promise<boolean> {
  if (isEdit(envelope) || envelope.senderIsBot || isSystemEvent(envelope)) return false;
  const command = parseCommand(envelope.text);
  if (!command || !o.hooks.aboutTheGroup(command.command)) return false;
  if (envelope.text.trim().split(/\s+/)[0]!.includes("@")) return false;
  const named = o.config.daemon.orchestrator;
  const desk = named ? o.registry.enabled().find((candidate) => candidate.config.id === named) : undefined;
  if (desk) {
    const own = o.config.gateways.find((gateway) => gateway.enabled && gateway.platform === envelope.gateway && gateway.agent === desk.config.id);
    // Another bot's copy: the orchestrator's own goes first, so the claim is its.
    if (own && own.id !== envelope.gatewayId && o.connected(own.id)) await (o.wait ?? pause)(DESK_FIRST_MS);
  }
  const owner = o.config.gateways.find((gateway) => gateway.id === envelope.gatewayId)?.agent;
  const agent: LoadedAgent | undefined = desk ?? (owner ? o.registry.get(owner) : undefined) ?? o.registry.enabled()[0];
  if (!agent) return false;
  const result = await o.hooks.run(command.command, command.args, agent, envelope);
  if (result.reply) await o.reply(envelope, result.reply, agent.config.id);
  return true;
}
