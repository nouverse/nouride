/**
 * Which `[[people]]` entry is this sender, and which ids are worth writing down.
 *
 * One human is one person; a platform's idea of their id is not. WhatsApp reports both a `@lid` and a
 * phone `@s.whatsapp.net` for the same account. A household member has a Telegram id and a Discord
 * snowflake. And on Discord it is worse than "one per platform": which of our connections a message
 * arrives on is decided by *which bot they tagged*, so `discord:nero:214…` recognises somebody talking
 * to Nero and leaves the same person a stranger the moment they tag Nox.
 *
 * That was the whole ambiguity. The fix is two rules:
 *
 * - **One spelling: the platform's.** `discord:214…` is the person on that platform, whichever of our
 *   bots they happen to address. The connection's view, `discord:nero:214…`, was a second spelling
 *   until 0.7.0 — and the one a household's WhatsApp ids ended up in, `whatsapp:nouva:628…`, which
 *   named somebody only while they wrote to Nouva's number. Written in a file, it is refused at load since 0.8.0
 *   (0.7.x rewrote every one); handed in by the daemon itself — a sender as a connection saw it — it is read as the
 *   platform's (`canonicalPersonId`).
 * - **Several ids per person**, so the name and the notes are written once — or none yet: a person is
 *   their key (`people/entry.ts`), and an account is attached to them when it is known.
 *
 * A bare `214…` is still refused, and that refusal is not pedantry: a Telegram user id and a Discord
 * snowflake are both numeric strings, so a bare id silently identifies one platform's stranger as
 * another platform's household member.
 */

import type { GatewayName, MessageEnvelope, Person } from "@nouride/shared";

/** The platforms an id may be qualified by. A first segment that is not one of these is a gateway id. */
const PLATFORMS: readonly GatewayName[] = ["discord", "telegram", "whatsapp", "web"];

export interface MatchedPerson {
  name: string;
  notes?: string;
}

/**
 * An id as it is read and written today: `platform:account`.
 *
 * - **The connection is dropped.** `whatsapp:nouva:628…@s.whatsapp.net` is `whatsapp:628…@s.whatsapp.net`:
 *   a person's account is theirs whichever of our numbers or bots they write to. A segment that is not a
 *   name — digits, as in a WhatsApp device id `628…:12@s.whatsapp.net` — is part of the account, and kept.
 *
 * The dashboard's `local:` (until 0.6) and a terminal's `web:dev` (until 0.7.18) are not read as today's any more: 0.7.x
 * rewrote them in every file, and `refusePersonId` names what to write instead.
 */
export function canonicalPersonId(id: string): string {
  const trimmed = id.trim();
  const [platform, connection, ...account] = trimmed.split(":");
  if (account.length > 0 && PLATFORMS.includes(platform as GatewayName) && /^[a-z][\w-]*$/i.test(connection ?? "")) {
    return `${platform}:${account.join(":")}`;
  }
  return trimmed;
}

/** Every account one entry claims, in today's spelling, without blanks or duplicates. */
export function idsOf(person: Pick<Person, "ids">): string[] {
  return [...new Set((person.ids ?? []).map(canonicalPersonId).filter(Boolean))];
}

/**
 * The two forms of this sender's id, most specific first.
 *
 * `gatewayId` already carries the platform (`discord:nero`), so the platform-qualified form is derived
 * from it rather than passed separately — one fewer thing a caller can get wrong.
 */
export function idFormsFor(input: { gatewayId: string; senderId: string }): string[] {
  const platform = input.gatewayId.split(":")[0] ?? input.gatewayId;
  const qualified = `${input.gatewayId}:${input.senderId}`;
  const onPlatform = `${platform}:${input.senderId}`;
  return qualified === onPlatform ? [qualified] : [qualified, onPlatform];
}

/**
 * Whether `entry` names this sender.
 *
 * Exact string comparison against both forms, never a prefix test: a prefix match would make
 * `discord:214` cover `discord:2149999` — a different person, silently.
 */
export function personIdMatches(
  entry: string,
  input: { gatewayId: string; senderId: string },
): boolean {
  return idFormsFor(input).includes(canonicalPersonId(entry));
}

/** The first entry that names this sender, or undefined. */
export function findPerson(
  people: readonly Person[],
  envelope: Pick<MessageEnvelope, "gatewayId" | "senderId">,
): MatchedPerson | undefined {
  const target = { gatewayId: envelope.gatewayId, senderId: envelope.senderId };
  const person = people.find((candidate) =>
    idsOf(candidate).some((id) => personIdMatches(id, target)),
  );
  if (!person) return undefined;
  return { name: person.name, ...(person.notes ? { notes: person.notes } : {}) };
}

/**
 * What a sender is called wherever the model reads their words: their `[[people]]` name when they are one of the
 * install's people — on every account they write from — and what the platform calls them otherwise. One person on
 * two accounts, or under a nickname like `~`, reads as one person, and as the person the system prompt names.
 */
export function speakerName(
  people: readonly Person[],
  sender: Pick<MessageEnvelope, "gatewayId" | "senderId"> & { senderName?: string | undefined },
): string {
  return findPerson(people, sender)?.name ?? (sender.senderName || sender.senderId);
}

/**
 * Whether this sender is, by `[[people]]`, someone with an admin's dashboard account.
 *
 * A chat sender proves only a platform id. `[[people]]` is where an admin says which ids are one person,
 * and an account linked there (`web:<account id>`, `/people/link`) carries a role — so a sender is an admin
 * when the person their id belongs to also holds an account that is one. Asked by `/daemon-restart`.
 */
export function senderIsAdmin(
  people: readonly Person[],
  envelope: Pick<MessageEnvelope, "gatewayId" | "senderId">,
  roleOf: (accountId: string) => string | undefined,
): boolean {
  return accountRoles(people, envelope, roleOf).includes("admin");
}

/** The people with an admin's dashboard account, by key: whose a knowledge collection with no settings is (0.8.20). */
export function adminKeys(people: readonly Person[], roleOf: (accountId: string) => string | undefined): string[] {
  return people.filter((person) => person.key && idsOf(person).some((id) => id.startsWith("web:") && roleOf(id.slice("web:".length)) === "admin")).map((person) => person.key);
}

/** Whether this sender, by `[[people]]`, holds a dashboard account at all — who a dashboard link goes to in a DM (0.8.11). */
export function senderHasAccount(
  people: readonly Person[],
  envelope: Pick<MessageEnvelope, "gatewayId" | "senderId">,
  roleOf: (accountId: string) => string | undefined,
): boolean {
  return accountRoles(people, envelope, roleOf).length > 0;
}

/** The roles of the accounts linked to the person this sender's id belongs to; none for a sender who is no one's. */
function accountRoles(people: readonly Person[], envelope: Pick<MessageEnvelope, "gatewayId" | "senderId">, roleOf: (accountId: string) => string | undefined): string[] {
  const target = { gatewayId: envelope.gatewayId, senderId: envelope.senderId };
  const person = people.find((candidate) => idsOf(candidate).some((id) => personIdMatches(id, target)));
  if (!person) return [];
  // `web:<account id>`: the account is what follows the platform.
  return idsOf(person)
    .filter((id) => id.startsWith("web:"))
    .flatMap((id) => roleOf(id.slice("web:".length)) ?? []);
}

/**
 * Why this id cannot be used, or null.
 *
 * Checked at load, because a mistyped id is invisible at runtime: the agent simply never recognises
 * anyone and nothing anywhere says why (invariant 7).
 */
export function refusePersonId(id: string): string | null {
  const trimmed = canonicalPersonId(id);
  if (!trimmed) return "is empty";

  const segments = trimmed.split(":");
  if (segments.length < 2) {
    return (
      `must name the platform, as "${platformHint(trimmed)}". A bare id is refused because a Telegram ` +
      `user id and a Discord snowflake are both numeric. Run \`nouride access\` to see the ids this ` +
      `daemon has seen`
    );
  }

  const [first] = segments;
  // Spellings from before 0.6 and 0.7.18, which 0.7.x rewrote and 0.8.0 does not read.
  if (first === "local") return `is the dashboard's spelling from before 0.6: write it as "web:${segments.slice(segments[1] === "dev" && segments.length > 2 ? 2 : 1).join(":")}"`;
  if (trimmed === "web:dev") return 'is a terminal\'s spelling from before 0.7.18: write it as "web:terminal"';
  if (!first || !PLATFORMS.includes(first as GatewayName)) {
    return `starts with "${first}", which is not a platform (expected one of ${PLATFORMS.join(", ")})`;
  }
  if (segments.slice(1).every((part) => part.trim().length === 0)) {
    return "names a platform but no sender";
  }
  return null;
}

/** A plausible platform-qualified spelling, for the error message. Discord is the common case. */
function platformHint(senderId: string): string {
  return `discord:${senderId}`;
}
