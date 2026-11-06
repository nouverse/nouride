/**
 * Buttons on Discord (G11): a row of message components under a message, and a press on one — a button interaction —
 * as the engine reads it, its answer carried out inside the three seconds Discord gives an interaction.
 */

import { ButtonStyle, ChannelType, ComponentType, MessageFlags, type ButtonInteraction } from "discord.js";
import type { ButtonPress, Logger, MessageButton, PressAnswer } from "@nouride/shared";

/**
 * How long a press may wait for its answer before it is acknowledged first and answered after. Discord fails an
 * interaction it has not heard back on in three seconds; the answer is almost always there at once — the gate is a
 * local database — and this leaves half a second for the acknowledgement itself to travel.
 */
const ACK_WITHIN_MS = 2_500;

/** How many buttons Discord takes in one row; a row of more fails the whole message. */
const PER_ROW = 5;

/**
 * The buttons as Discord draws them — a yes green, a no red, anything else grey — five to a row. A mission's question
 * carries up to six answers; as one row of six Discord refused the message, question and all.
 */
export function buttonRow(buttons: readonly MessageButton[]) {
  const style = (button: MessageButton) => (button.style === "positive" ? ButtonStyle.Success : button.style === "negative" ? ButtonStyle.Danger : ButtonStyle.Secondary);
  const rows = [];
  for (let at = 0; at < buttons.length; at += PER_ROW) {
    rows.push({ type: ComponentType.ActionRow, components: buttons.slice(at, at + PER_ROW).map((button) => ({ type: ComponentType.Button, style: style(button), label: button.label, custom_id: button.data })) });
  }
  return rows;
}

/** A press, as the engine reads one: where the message is, who pressed, and what the button carries. */
export function discordPress(interaction: ButtonInteraction, gatewayId: string): ButtonPress {
  return {
    gatewayId,
    chatId: interaction.channelId,
    // Outside a server it is somebody's DM — a bot is in no group DM — whether or not the channel is cached.
    chatType: interaction.inGuild() ? "channel" : interaction.channel?.type === ChannelType.GroupDM ? "group" : "dm",
    messageId: interaction.message.id,
    data: interaction.customId,
    senderId: interaction.user.id,
    senderName: interaction.member && "displayName" in interaction.member ? String(interaction.member.displayName) : interaction.user.username,
  };
}

/**
 * Carry out the engine's answer to a press: the message settled — rewritten, its buttons gone — and the notice to the
 * presser alone, in a reply only they see. Acknowledged inside Discord's three seconds whatever happens: a press not
 * acknowledged reads "This interaction failed" to the person who made it. An answer later than `ACK_WITHIN_MS` is
 * acknowledged first and carried out after.
 */
export async function carryOut(interaction: ButtonInteraction, answering: Promise<PressAnswer>, log: Logger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(resolve, ACK_WITHIN_MS, null)));
  const answer = await Promise.race([answering, late]);
  clearTimeout(timer);
  const settled = (content: string) => ({ content: content.slice(0, 2_000), components: [], allowedMentions: { parse: [] } });
  const notice = (content: string) => ({ content: content.slice(0, 2_000), flags: MessageFlags.Ephemeral as const });
  try {
    if (answer === null) {
      await interaction.deferUpdate();
      const after = await answering;
      if (after.settled) await interaction.editReply(settled(after.settled));
      if (after.notice) await interaction.followUp(notice(after.notice));
      return;
    }
    if (answer.settled) {
      await interaction.update(settled(answer.settled));
      if (answer.notice) await interaction.followUp(notice(answer.notice));
    } else if (answer.notice) {
      await interaction.reply(notice(answer.notice));
    } else {
      await interaction.deferUpdate();
    }
  } catch (err) {
    // Expired, or answered by another shard: the person's client has moved on, and there is nobody left to tell.
    log.debug("could not answer a press", { error: String(err) });
  }
}
