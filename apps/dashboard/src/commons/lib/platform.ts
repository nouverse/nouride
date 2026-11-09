/**
 * A chat platform's name as people write it, from an id or a connection: `telegram:nouva` → Telegram,
 * `whatsapp:628…@s.whatsapp.net` → WhatsApp. The prefix is the platform, so nothing needs looking up.
 */

const NAMES: Record<string, string> = { telegram: "Telegram", discord: "Discord", whatsapp: "WhatsApp", web: "Web" };

export function platformName(id: string): string {
  const platform = id.split(":")[0] ?? id;
  return NAMES[platform] ?? platform;
}

/** What a platform calls a conversation of many, as its people say it: a Discord channel, a Telegram group. */
const ROOM_WORDS: Record<string, string> = { discord: "channel" };

export function roomWord(id: string): string {
  return ROOM_WORDS[id.split(":")[0] ?? id] ?? "group";
}
