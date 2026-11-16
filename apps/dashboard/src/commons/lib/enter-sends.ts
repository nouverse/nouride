/**
 * Whether Enter in the message box sends the message.
 *
 * With a keyboard it does, and Shift+Enter is a new line. On a phone there is no Shift to hold with Enter: the
 * keyboard's Enter was the only key that could make a new line, and it sent the message half written. So where the
 * pointer is a finger (`pointer: coarse`, a phone or a tablet), Enter is a new line and the send button sends. Asked
 * at the key, not once: a tablet's keyboard can be taken off, and a laptop's screen can be touched.
 */
export function enterSends(event: { key: string; shiftKey: boolean }, coarse: boolean = fingerPointer()): boolean {
  return event.key === "Enter" && !event.shiftKey && !coarse;
}

function fingerPointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}
