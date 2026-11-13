/**
 * `send_message` — post into another chat this agent knows, and have that chat remember it (0.7.23).
 *
 * Found on the live box. Asked in a Telegram DM to "send it to the WhatsApp group", an agent with no way to do that read
 * the daemon's SQLite file with python to find the group's id, then made a one-shot cron job with `--text` to post it.
 * It arrived — and the group's conversation never learned it had been said, so when somebody there answered it, the
 * agent in that chat had no idea what they were answering.
 *
 * So two halves, and the second is the one that matters:
 *
 * - **Addressing without ids.** `to` is a person (their key or name: their one-to-one chat), a group's name, or
 *   `gateway:chat` from the list this tool gives back. The agent never needs the database, and the prompt says not to
 *   read it.
 * - **The message lands in that chat's conversation.** After the platform takes it, it is appended to this agent's
 *   conversation there as its own words, after a `[system]` line saying where it was sent from — so the next turn in
 *   that chat has it in its history (`pipeline/send-message.ts`).
 *
 * Only chats this agent can reach, through connections that are its own: one it owns (`[gateways.*] agent`), or one
 * with no owner where it already has a conversation. Another agent's bot is never used — that would be speaking with
 * somebody else's face. Never the chat it is in: that is an answer, not a message.
 *
 * Asked like any tool that changes something, at the agent's approval level — it speaks to people outside this
 * conversation. In a scheduled job's run that is the level the run is at: the job was turned on by a person, and
 * nothing more is asked for where it sends. An unknown or ambiguous `to` is refused before anybody is asked, with the
 * chats it can reach.
 *
 * **The list has a call of its own: no `to`.** Nothing is sent and nobody is asked. An unknown `to` used to be the only
 * way to see the chats, and the schema said so; agents on two different models then made a recipient up to get the
 * list (`to: "list"`, `text: "test"`), in a chat and at the start of a scheduled job's run. Each was a failed step on
 * the person's page, and a message waiting for the chat that would one day carry that name.
 */

import type { Tool, ToolContext, ToolResult } from "@nouride/shared";

/** A chat this agent may send into — what `to` is resolved against, and what an error lists. */
export interface ReachableChat {
  gatewayId: string;
  chatId: string;
  /** The platform, for a person reading the list: "telegram". */
  platform: string;
  kind: "dm" | "group";
  /** A group's name, where it has one (`roomName`): a dashboard room's title, the operator's rename, its platform's name. */
  title?: string;
  /** In a one-to-one, the person on the other end; in a group, who has spoken there lately. */
  people: { key?: string; name: string }[];
  /** When this agent's conversation there last moved; 0 for a person's chat it has never used. */
  lastActive: number;
}

export interface SendTargets {
  /** Most recently active first. */
  chats: ReachableChat[];
  /** Connections that are another agent's own: never sent through, and `to` naming one is refused as such. */
  othersGateways: string[];
}

export interface SendMessageOptions {
  /** The chats this agent can reach from where it is, read per call — conversations start while the daemon runs. */
  targets(ctx: ToolContext): SendTargets;
  /** Put the text on the wire, and into that chat's conversation once it landed. */
  post(ctx: ToolContext, chat: ReachableChat, text: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** How many chats an error lists — the most recently active. Enough for a household; not a page of ids. */
const LISTED = 20;

/** A conversation's address, as `to` takes it and the list shows it. */
function chatAddress(chat: { gatewayId: string; chatId: string }): string {
  return `${chat.gatewayId}:${chat.chatId}`;
}

/** Lower case, accents off, everything else a dash: "Keluarga Besar" and "keluarga-besar" are one name. */
function fold(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** One chat, in words: "the telegram one-to-one with Sam", "the whatsapp group "keluarga"". */
function describeChat(chat: ReachableChat): string {
  // The platform as the daemon names it, lower case: a label table would be one more list of platforms to keep.
  const platform = chat.platform;
  if (chat.kind === "dm") return `the ${platform} one-to-one with ${chat.people[0]?.name ?? chat.chatId}`;
  const named = chat.title ? ` "${chat.title}"` : "";
  const present = chat.people.length > 0 ? ` (${chat.people.map((person) => person.name).join(", ")})` : "";
  return `the ${platform} group${named}${present}`;
}

function listing(chats: readonly ReachableChat[], heading: string): string {
  // The People list by its name: `[[people]]` sent a model to look for a table in config.toml, which 0.8.18 moved out.
  if (chats.length === 0) return `${heading} There are none: you can only send into a chat you have already talked in, or to a person on the People list through a connection of your own.`;
  const lines = chats.slice(0, LISTED).map((chat) => {
    const keys = chat.kind === "dm" ? chat.people.flatMap((person) => (person.key ? [person.key] : [])) : [];
    return `- \`${chatAddress(chat)}\`: ${describeChat(chat)}${keys.length ? ` · to: "${keys[0]}"` : ""}`;
  });
  const more = chats.length > LISTED ? `\n(${chats.length - LISTED} less recent not shown.)` : "";
  return `${heading} Give \`to\` one of these addresses, a person's key, or a group's name:\n${lines.join("\n")}${more}`;
}

/** How several groups with one name come down to one, in order: this connection, this platform, a chat you have talked in. */
const NARROWERS: ((chat: ReachableChat, here: { gatewayId: string; gateway: string }) => boolean)[] = [
  (chat, here) => chat.gatewayId === here.gatewayId,
  (chat, here) => chat.platform === here.gateway,
  (chat) => chat.lastActive > 0,
];

type Resolved = { ok: true; chat: ReachableChat } | { ok: false; reason: string };

/**
 * Which chat `to` means, or why it means none — pure, so every branch is a table row in a test.
 *
 * The rule, in order:
 * 1. An address, `gateway:chat`, is that chat — if it is one this agent can reach.
 * 2. Otherwise a name: a person's key or name means their one-to-one chat; a group's name means that group.
 * 3. A person with more than one one-to-one — a Telegram and a WhatsApp, two accounts — is not guessed at: nothing is
 *    sent, and the answer lists them, so the agent picks the one that was asked for. Live, "to my WhatsApp" went to
 *    the operator's second Telegram account because it shared the connection the request came in on.
 * 4. Several groups of one name are narrowed, each step keeping what it can: the connection this conversation is on,
 *    then the same platform, then a chat this agent has already talked in. Still several, or none, and nothing is
 *    sent — the answer lists what there is.
 *
 * The chat this turn is in is never a match: that is a reply, and it goes out as one.
 */
export function resolveSendTarget(to: string, targets: SendTargets, here: { gatewayId: string; chatId: string; gateway: string }): Resolved {
  const wanted = to.trim();
  const isHere = (chat: { gatewayId: string; chatId: string }) => chat.gatewayId === here.gatewayId && chat.chatId === here.chatId;
  if (!wanted) return { ok: false, reason: listing(targets.chats, "`to` is empty.") };
  if (wanted === chatAddress(here)) return { ok: false, reason: "that is the chat you are in, so answer there, in your reply" };

  const exact = targets.chats.find((chat) => chatAddress(chat) === wanted);
  if (exact) return { ok: true, chat: exact };
  const others = targets.othersGateways.find((gatewayId) => wanted.startsWith(`${gatewayId}:`));
  if (others) return { ok: false, reason: `${others} is another agent's connection, and you only send through your own` };

  const name = fold(wanted);
  const named = targets.chats.filter(
    (chat) =>
      (chat.kind === "dm" && chat.people.some((person) => person.key === name || fold(person.name) === name)) ||
      (chat.kind === "group" && chat.title !== undefined && fold(chat.title) === name),
  );
  const matches = named.filter((chat) => !isHere(chat));
  if (matches.length === 0) {
    if (named.length > 0) return { ok: false, reason: "that is the chat you are in, so answer there, in your reply" };
    return { ok: false, reason: listing(targets.chats, `No chat you can reach is "${wanted}".`) };
  }
  if (matches.length === 1) return { ok: true, chat: matches[0]! };

  if (matches.some((chat) => chat.kind === "dm")) {
    return { ok: false, reason: listing(matches, `"${wanted}" has ${matches.length} chats you can reach. Give \`to\` the address of the one asked for.`) };
  }
  let left = matches;
  for (const narrower of NARROWERS) {
    const narrowed = left.filter((chat) => narrower(chat, here));
    if (narrowed.length === 1) return { ok: true, chat: narrowed[0]! };
    if (narrowed.length > 1) left = narrowed;
  }
  return { ok: false, reason: listing(left, `"${wanted}" could be ${left.length} chats.`) };
}

function textOf(args: Record<string, unknown>): string {
  return typeof args.text === "string" ? args.text.trim() : "";
}

/** No `to`: the call that asks which chats there are. With a `text` beside it, a send that forgot where: listed too. */
function asksForChats(args: Record<string, unknown>): boolean {
  return typeof args.to !== "string" || !args.to.trim();
}

export function createSendMessageTool(options: SendMessageOptions): Tool {
  const resolve = (args: Record<string, unknown>, ctx: ToolContext): Resolved =>
    resolveSendTarget(typeof args.to === "string" ? args.to : "", options.targets(ctx), ctx);

  return {
    requiresApproval: true,
    definition: {
      name: "send_message",
      description:
        "Send a message into another chat you know (a person's one-to-one chat or a group), and it becomes part of that " +
        "chat's conversation. Not for this chat: answer here in your reply. With no `to`, it lists the chats you can " +
        "reach and sends nothing.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: 'A person\'s key or name ("mira"), a group\'s name, or a chat address `gateway:chat` from the list. Left out: the list.',
          },
          text: { type: "string", description: "The message, exactly as it should arrive." },
        },
        // Neither is required: the call for the list has no `to`, and a `text` it had to carry would be made up.
        required: [],
      },
    },

    // Where it went and how long it was. The words are in the chat they went to, and go when that conversation does.
    auditArgs: (args, ctx) => {
      const found = resolve(args, ctx);
      return { to: typeof args.to === "string" ? args.to : null, chat: found.ok ? chatAddress(found.chat) : null, chars: textOf(args).length };
    },

    gate(args, ctx) {
      // The list is read, and nothing leaves: nobody is asked.
      if (asksForChats(args)) return { action: "run", via: "ceiling" };
      if (!textOf(args)) return { action: "refuse", reason: "`text` is empty" };
      const found = resolve(args, ctx);
      if (!found.ok) return { action: "refuse", reason: found.reason };
      /**
       * The same question in a scheduled job's run as anywhere, answered by the level the run is at. A run used to be
       * held, at every level, for a send to any chat but the one its job reports to: a person who had asked for "a digest
       * on my WhatsApp every morning" and turned that job on themselves found each run held, for a yes they had given.
       * A job is turned on by a person, and that is their yes to what it sends.
       */
      return { action: "ask", grantable: false, reason: `it sends a message to ${describeChat(found.chat)}, outside this conversation` };
    },

    // Off the machine to someone, unless it is the chat a scheduled job's run reports to — a person named that one.
    sendsOut(args, ctx) {
      const found = resolve(args, ctx);
      if (!found.ok || (ctx.sendsTo && chatAddress(found.chat) === chatAddress(ctx.sendsTo))) return null;
      return { what: `sends a message to ${describeChat(found.chat)}`, to: [`chat:${chatAddress(found.chat)}`] };
    },

    async execute(args, ctx): Promise<ToolResult> {
      if (asksForChats(args)) return { content: listing(options.targets(ctx).chats, "Nothing was sent: there was no `to`."), isError: false };
      const text = textOf(args);
      if (!text) return { content: "`text` is empty.", isError: true };
      const found = resolve(args, ctx);
      if (!found.ok) return { content: found.reason, isError: true };
      const posted = await options.post(ctx, found.chat, text);
      if (!posted.ok) return { content: `Not sent to ${describeChat(found.chat)}: ${posted.reason}`, isError: true };
      return {
        content: `Delivered to ${describeChat(found.chat)}: the platform took it, so there is nothing to check. It is in your conversation there now, so you will have it when somebody answers.`,
        isError: false,
      };
    },
  };
}
