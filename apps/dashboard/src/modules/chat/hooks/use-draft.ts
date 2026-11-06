/**
 * A message written for the person (`AskAgentButton`, 0.8.19): put in the box to read, change and send, and never sent
 * from here. Then dropped from the address, so a reload does not put it back over what they changed — the address once
 * carried a message that was sent again on every reload (`lib/start-with.ts`).
 */

import { useEffect, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";

export function useDraft({ draft, agent, setInput, textareaRef }: {
  draft: string | undefined;
  /** The agent the address names, kept in it when the draft is dropped. */
  agent: string | undefined;
  setInput: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!draft) return;
    setInput(draft);
    void navigate({ to: "/chat", search: agent ? { agent } : {}, replace: true });
    // Sized to the message once it is in the box, as typing sizes it, and the caret put there.
    requestAnimationFrame(() => {
      const box = textareaRef.current;
      if (!box) return;
      box.style.height = "auto";
      box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
      box.focus();
    });
  }, [draft, agent, navigate, setInput, textareaRef]);
}
