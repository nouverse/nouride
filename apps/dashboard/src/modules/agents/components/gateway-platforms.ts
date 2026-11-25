/**
 * The chat apps a connection can be on, with what each one's form asks for, and which of them an agent can still be
 * given one on. Beside the Connections list (`GatewayList`), which draws from it.
 */

export type Platform = "telegram" | "discord" | "whatsapp";

export const PLATFORMS: {
  id: Platform;
  label: string;
  tokenLabel: string;
  tokenHint: string;
  note?: string;
  pairs?: boolean;
}[] = [
  {
    id: "telegram",
    label: "Telegram",
    tokenLabel: "Bot Token", // plain-words-ok: what BotFather calls it, and where the person finds it
    tokenHint: "From @BotFather in Telegram (it looks like 123456:ABC-DEF…)",
    // A group is all but dead on Telegram until this is done: with privacy mode on, the Bot API hands a
    // bot that is not an admin only commands and replies to its own messages — not even a message that
    // tags it (verified live; see the connect-time warning in the gateway). From a chat that looks like
    // the bot being down, not unconfigured.
    note: "In groups: disable privacy mode in @BotFather (/setprivacy → Disable, then remove and re-add the bot), or make the bot a group admin. Otherwise Telegram delivers only commands and replies to its own messages, not even a message that tags it.",
  },
  {
    id: "discord",
    label: "Discord",
    tokenLabel: "Bot Token", // plain-words-ok: what the Discord Developer Portal calls it, and where the person finds it
    tokenHint: "From the Discord Developer Portal.",
    note: "In the Discord Developer Portal, turn on Message Content Intent for the bot.",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    tokenLabel: "Encryption Key (optional)",
    tokenHint: "Leave it empty and one is made for you. The link to WhatsApp is kept encrypted, and survives restarts.",
    note: "Works the way WhatsApp Web does. After saving, restart Nouride and scan the QR code.",
    pairs: true,
  },
];

/**
 * The chat apps an agent can still be given a connection on: one on each, so an app it already answers on is not
 * offered again. A second bot or number on the same app for one agent is nothing the page makes; one written into the
 * file by hand is still shown as its own card.
 */
export function platformsToAdd(mine: readonly { platform: string }[]): typeof PLATFORMS {
  return PLATFORMS.filter((platform) => !mine.some((gateway) => gateway.platform === platform.id));
}
