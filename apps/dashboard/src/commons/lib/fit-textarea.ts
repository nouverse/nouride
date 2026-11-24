/**
 * A text box as tall as its text, up to a height it then scrolls at: the message box of a chat.
 *
 * The text's height is read from the box collapsed to one line, and for that moment whatever is laid out around it
 * has that much more room. A conversation above it stretched into it, the browser pulled the conversation's scroll
 * position back to fit, and when the box came back at the height it already had, nothing put the conversation at its
 * end again: what follows the end is told of a size that changed, and none had. On a phone, a letter typed on the
 * fourth line of a message left the newest answer three lines under the box, and a new line put it back.
 *
 * What holds the box keeps its height while the text is measured, so nothing around it moves.
 */

/** The tallest the box grows: about seven lines of a message. */
const TALLEST_PX = 160;

export function fitTextarea(box: HTMLTextAreaElement, tallest = TALLEST_PX): void {
  const holder = box.parentElement;
  const held = holder?.style.minHeight ?? "";
  if (holder) holder.style.minHeight = `${holder.offsetHeight}px`;
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, tallest)}px`;
  if (holder) holder.style.minHeight = held;
}
