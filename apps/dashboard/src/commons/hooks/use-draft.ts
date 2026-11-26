/**
 * A message written for the person (`AskAgentButton` in the floating chat, a `?draft=` link on Chats; 0.8.19): put in
 * the box to read, change and send, and never sent from here. Then handed back to whoever gave it (`onTaken`), which
 * lets go of it, so it is not put back over what the person changed: the address once carried a message that was sent
 * again on every reload (`lib/start-with.ts`).
 */

import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { fitTextarea } from "@/commons/lib/fit-textarea";

export function useDraft({ draft, onTaken, setInput, onPut, textareaRef }: {
  draft: string | undefined;
  /** The draft is in the box: its giver drops it (the Chats page from its address, the floating chat from its store). */
  onTaken: () => void;
  setInput: Dispatch<SetStateAction<string>>;
  /** The rest of what the box holds goes too: files attached and not sent went with the new request. */
  onPut: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): void {
  const taken = useRef(onTaken);
  taken.current = onTaken;
  const put = useRef(onPut);
  put.current = onPut;
  useEffect(() => {
    if (!draft) return;
    // The message is what the box holds now, whatever it held. Put under it, an ask from one page sat under the ask
    // from the page before, and the two were sent as one muddled request.
    setInput(draft);
    put.current();
    taken.current();
    // Sized to the message once it is in the box, as typing sizes it, and the caret put there.
    requestAnimationFrame(() => {
      const box = textareaRef.current;
      if (!box) return;
      fitTextarea(box);
      box.focus();
    });
  }, [draft, setInput, textareaRef]);
}
