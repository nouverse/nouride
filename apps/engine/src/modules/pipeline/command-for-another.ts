/**
 * A command written with the tag of another of our bots in front, on a copy that is not that bot's.
 *
 * `@Nox /status`: how a command is written where a tag is how a bot is addressed. Every one of our bots in the room
 * is handed the message. The bot it names has it with its own tag taken off the front by its adapter, so there it
 * is a command and is answered as one. Every other copy still has the tag in front: its text does not begin with
 * `/`, so it was routed as a message, to the agent the tag names, and whichever copy came first took it. Where that
 * was not the named bot's own, the agent answered a command as if it were talk. A command about the group
 * (`/mention`), which is answered before routing and so takes no claim, was answered and talked about as well, and
 * `@Lead /mention @Nox` got a turn from Nox on top, whose bot the words tag.
 *
 * So such a copy is nobody's here: the command is the named bot's, on its own copy.
 *
 * Narrow on purpose. Only the tags of our own bots on this platform, as their connections say them, never a name
 * (`nexa: /new` is how an agent that shares a bot is addressed, and stays). And not where this bot's tag was at the
 * front too (`@Lead @Nox /status`, taken off by the adapter): that was addressed here as well, and is left as it was.
 */

import type { MessageEnvelope } from "@nouride/shared";
import { parseCommand, type HookRegistry } from "@/modules/hooks/registry.ts";
import { isSystemEvent } from "./deps.ts";
import { isEdit } from "./edit-rules.ts";

/** A tag as it is compared: Discord writes one with and without `!`, and a handle in any case. */
const plain = (tag: string): string => tag.toLowerCase().replace(/^<@!/, "<@");

export function commandForAnotherBot(
  o: {
    hooks: Pick<HookRegistry, "has">;
    /** What tags each of our bots on a platform, by its connection's id. */
    tags: (platform: MessageEnvelope["gateway"]) => Readonly<Record<string, string>>;
  },
  envelope: MessageEnvelope,
): boolean {
  if (envelope.chatType === "dm" || isEdit(envelope) || envelope.senderIsBot || isSystemEvent(envelope)) return false;
  const all = o.tags(envelope.gateway);
  const own = all[envelope.gatewayId];
  const others = new Set(Object.entries(all).filter(([connection]) => connection !== envelope.gatewayId).map(([, tag]) => plain(tag)));
  const words = envelope.text.trim().split(/\s+/);
  let lead = 0;
  while (lead < words.length && others.has(plain(words[lead]!))) lead++;
  if (lead === 0) return false;
  const command = parseCommand(words.slice(lead).join(" "));
  if (!command || !o.hooks.has(command.command)) return false;
  // This bot's tag was at the front as well, and its adapter took it off: addressed here too.
  const strippedHere = envelope.mentionsSelf === true && (!own || !words.some((word) => plain(word) === plain(own)));
  return !strippedHere;
}
