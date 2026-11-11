/**
 * A message written for the person (`AskAgentButton`, 0.8.19): put in the box to read, change and send, and never sent
 * from here. Then handed back to whoever gave it (`onTaken`), which lets go of it, so it is not put back over what the
 * person changed: the address once carried a message that was sent again on every reload (`lib/start-with.ts`).
 */

import { useEffect, useRef, type RefObject } from "react";

export function useDraft({ draft, onTaken, setInput, textareaRef }: {
  draft: string | undefined;
  /** The draft is in the box: its giver drops it (the Chats page from its address). */
  onTaken: () => void;
  setInput: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): void {
  const taken = useRef(onTaken);
  taken.current = onTaken;
  useEffect(() => {
    if (!draft) return;
    setInput(draft);
    taken.current();
    // Sized to the message once it is in the box, as typing sizes it, and the caret put there.
    requestAnimationFrame(() => {
      const box = textareaRef.current;
      if (!box) return;
      box.style.height = "auto";
      box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
      box.focus();
    });
  }, [draft, setInput, textareaRef]);
}
