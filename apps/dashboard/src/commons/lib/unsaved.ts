/**
 * Whether the page on screen holds something a person wrote and has not saved. A page says so while it does
 * (`useUnsaved`), and what would take the person to another page by itself asks first (`holdsUnsaved`): the chat that
 * floats over a page opens what an agent made, and must not do that over a form half written.
 */

import { useEffect } from "react";

let holders = 0;

export function useUnsaved(holds: boolean): void {
  useEffect(() => {
    if (!holds) return undefined;
    holders += 1;
    return () => {
      holders -= 1;
    };
  }, [holds]);
}

export const holdsUnsaved = (): boolean => holders > 0;
