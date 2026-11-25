/**
 * What a WhatsApp number knows of itself: its own addresses and the groups it is in, as its bridge says them.
 *
 * With two numbers in one daemon, each is handed the other's messages in a group they share, as a person's, and a
 * group's message reaches only the numbers that are in it. The adapter answers the daemon's two questions from this:
 * whether an address is this number's (`Gateway.ownsAddress`, `selfId`) and whether it is in a group (`Gateway.sees`).
 */

/** An address as one account, without its device: `628…:12@s.whatsapp.net` is `628…@s.whatsapp.net`. */
const bare = (jid: string): string => jid.replace(/:\d+(?=@)/, "").trim();

export class NumberItself {
  /** Its phone address once linked, its hidden one as messages say it. */
  private readonly own = new Set<string>();
  /** The groups it is in, as its bridge last said; null until it has. */
  private groups: ReadonlySet<string> | null = null;

  /** Addresses the bridge said are this number's: the one it linked as, and those a message carries. */
  isAlso(ids: readonly string[]): void {
    for (const id of ids) if (id) this.own.add(bare(id));
  }

  /** Every group it is in, whole, as the bridge said. */
  isIn(ids: readonly string[]): void {
    this.groups = new Set(ids);
  }

  /** Its phone address, the one a `selfId` names. */
  get phone(): string | undefined {
    return [...this.own].find((id) => id.endsWith("@s.whatsapp.net"));
  }

  owns(id: string): boolean {
    return this.own.has(bare(id));
  }

  /** Not known for a one-to-one chat, nor before the bridge has said. */
  sees(chatId: string): boolean | undefined {
    if (!this.groups || !chatId.endsWith("@g.us")) return undefined;
    return this.groups.has(chatId);
  }
}
