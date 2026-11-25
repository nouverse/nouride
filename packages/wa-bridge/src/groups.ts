/**
 * The groups this number is in, as WhatsApp says.
 *
 * With two numbers in one daemon, a group's message reached on one of them was routed as though every number were in
 * the group: the other's agent was counted as one that could answer, the front desk answered, and its answer went out
 * through its own number, which was not in the group, and was lost. What tells them apart is this: fetched whole once
 * the number is linked, then kept by the joins and leaves WhatsApp reports of it. Unknown until the fetch answers, and
 * said so by saying nothing: the daemon then counts the number as it always did.
 */

/** An address as one account: without its device, so `628…:12@s.whatsapp.net` is `628…@s.whatsapp.net`. */
const bare = (jid: string | undefined): string => (jid ?? "").replace(/:\d+(?=@)/, "");

/** A participant as WhatsApp hands one: an address, or a contact with its phone and its hidden id. */
type Participant = string | { id?: string; lid?: string; phoneNumber?: string };

/** Whether a change to a group's people is about this number: its own address among them, by phone or hidden id. */
export function aboutSelf(participants: readonly Participant[], self: readonly string[]): boolean {
  const mine = new Set(self.map(bare).filter(Boolean));
  return participants.some((one) => (typeof one === "string" ? [one] : [one.id, one.lid, one.phoneNumber]).some((id) => mine.has(bare(id))));
}

export class Membership {
  private ids: Set<string> | null = null;

  /** `told` hears the whole set after each change, the way the daemon keeps it. */
  constructor(private readonly told: (ids: string[]) => void) {}

  /** Every group the number is in, as fetched. */
  fetched(ids: Iterable<string>): void {
    this.ids = new Set(ids);
    this.tell();
  }

  /** Added to groups, or made one. Before the fetch there is nothing to add to: the fetch says it all. */
  joined(ids: Iterable<string>): void {
    if (!this.ids) return;
    const before = this.ids.size;
    for (const id of ids) this.ids.add(id);
    if (this.ids.size !== before) this.tell();
  }

  /** Removed from a group, or left it. */
  left(id: string): void {
    if (this.ids?.delete(id)) this.tell();
  }

  private tell(): void {
    this.told([...(this.ids ?? [])].sort());
  }
}
