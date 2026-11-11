/**
 * A message written for the person (`AskAgentButton` in the floating chat, a `?draft=` link on Chats; 0.8.19): put in
 * the box to read, change and send, and never sent from here. Then handed back to whoever gave it (`onTaken`), which
 * lets go of it, so it is not put back over what the person changed: the address once carried a message that was sent
 * again on every reload (`lib/start-with.ts`).
 */

import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";

/**
 * The box with the message in it. An empty box is the message. What the person had typed is theirs and stays: the
 * message goes under it, on a line of its own, for them to join or delete. A button pressed twice writes it once.
 */
export function withDraft(typed: string, draft: string): string {
  if (!typed.trim()) return draft;
  return typed.includes(draft) ? typed : `${typed.trimEnd()}\n${draft}`;
}

export function useDraft({ draft, onTaken, setInput, textareaRef }: {
  draft: string | undefined;
  /** The draft is in the box: its giver drops it (the Chats page from its address, the floating chat from its store). */
  onTaken: () => void;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): void {
  const taken = useRef(onTaken);
  taken.current = onTaken;
  useEffect(() => {
    if (!draft) return;
    setInput((typed) => withDraft(typed, draft));
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
