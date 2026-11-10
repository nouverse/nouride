/**
 * A chat platform's name as people write it, from an id or a connection: `telegram:nouva` → Telegram,
 * `whatsapp:628…@s.whatsapp.net` → WhatsApp. The prefix is the platform, so nothing needs looking up.
 */

const NAMES: Record<string, string> = { telegram: "Telegram", discord: "Discord", whatsapp: "WhatsApp", web: "Web" };

export function platformName(id: string): string {
  const platform = id.split(":")[0] ?? id;
  return NAMES[platform] ?? platform;
}

/**
 * Each app's colour on its tag: WhatsApp's green, Telegram's blue, Discord's blurple. All three were one lilac pill, so
 * a list of groups from three apps read as one app.
 *
 * Drawn toward the text colour, as an agent's colour is (`agent-tints.ts`), so one value reads on either theme: lighter
 * on the night's violet grey, deeper on the day's cream. 55% of the hue rather than an agent's 70%, each hue's lightness
 * set between the two themes' needs: at 70% no hue reads at AA on its own tint in both themes (WhatsApp's own green
 * came to 2.7:1 by day). These read at 4.8:1 or better in both, an open row's lilac by night the lowest, which
 * `tests/platform-tints.test.ts` holds.
 */
const HUES: Record<string, string> = { whatsapp: "#00a647", telegram: "#0e9ad8", discord: "#7487ff" };

/** An app's colour, for its tag's words and tint; none for one with no colour of its own (the dashboard's "Web"). */
export function platformTint(id: string): string | undefined {
  const hue = HUES[id.split(":")[0] ?? id];
  return hue ? `color-mix(in oklab, ${hue} 55%, var(--color-base-content))` : undefined;
}

/** What a platform calls a conversation of many, as its people say it: a Discord channel, a Telegram group. */
const ROOM_WORDS: Record<string, string> = { discord: "channel" };

export function roomWord(id: string): string {
  return ROOM_WORDS[id.split(":")[0] ?? id] ?? "group";
}
