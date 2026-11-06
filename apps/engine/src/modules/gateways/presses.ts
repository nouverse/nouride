/**
 * Where a press on a button goes (G11). A connection hands its presses to one handler (`Gateway.onPress`), and more
 * than one thing in the daemon asks with buttons — an approval's prompt, a proposal's card (0.8.0) — so this is that
 * handler: each press to whichever owns its data, and one nobody owns answered as a button no longer known.
 */

import type { ButtonPress, Gateway, PressAnswer } from "@nouride/shared";

export interface PressOwner {
  /** Whether a press carrying this data is this one's to answer. */
  owns(data: string): boolean;
  press(press: ButtonPress): Promise<PressAnswer>;
}

/** Every connection with buttons hands its presses here. Once, after the gateways are built. */
export function routePresses(gateways: Iterable<Gateway>, owners: readonly PressOwner[]): void {
  for (const gateway of gateways) {
    gateway.onPress?.(async (press) => (await owners.find((owner) => owner.owns(press.data))?.press(press)) ?? { notice: "That button is not one I know any more." });
  }
}
