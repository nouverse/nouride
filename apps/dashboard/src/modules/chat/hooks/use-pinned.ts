/**
 * The groups pinned to Chats in this browser, by `groupKey`: a group looked at often, kept with the conversations
 * rather than a switch away. Per browser for now, as the rest of what the list remembers.
 */

import { useCallback } from "react";
import { isStrings, useKept } from "@/commons/hooks/use-kept";

const KEY = "nouride-chat-pinned-groups";

export function usePinnedGroups(): [string[], (key: string) => void] {
  const [pinned, setPinned] = useKept<string[]>(KEY, [], isStrings);
  const toggle = useCallback((key: string) => setPinned((was) => (was.includes(key) ? was.filter((one) => one !== key) : [...was, key])), [setPinned]);
  return [pinned, toggle];
}
