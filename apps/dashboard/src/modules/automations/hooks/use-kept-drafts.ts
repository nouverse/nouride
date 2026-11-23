/**
 * One person's unsaved automation drafts in this browser (`lib/kept-draft.ts`), read and written: by the page that
 * edits one, as it is typed, and by the list, which says which automations have changes waiting and which new one was
 * never saved.
 */

import { useCallback } from "react";
import { keepNow, keptNow, useKept } from "@/commons/hooks/use-kept";
import { isKeptDrafts, keptKey, withKept, type KeptDraft, type KeptDrafts } from "../lib/kept-draft";

const NONE: KeptDrafts = {};

/** Where a page's draft is kept: whose drafts (`keptKey`), and which of them is this page's. */
export interface Keeping {
  key: string;
  id: string;
}

export const keptOf = (keeping: Keeping): KeptDraft | undefined => keptNow(keeping.key, NONE, isKeptDrafts)[keeping.id];

/** A page's draft kept, or forgotten. Written without a render of the page that writes it. */
export const keep = (keeping: Keeping, kept: KeptDraft | null): void => keepNow(keeping.key, withKept(keptNow(keeping.key, NONE, isKeptDrafts), keeping.id, kept));

/** The reader's kept drafts, followed as they change here or in another tab, and one of them put back or thrown away. */
export function useKeptDrafts(who: string | undefined): { drafts: KeptDrafts; set: (id: string, kept: KeptDraft | null) => void } {
  // Nobody signed in keeps nothing, under a key nothing is written to.
  const [drafts, write] = useKept<KeptDrafts>(keptKey(who ?? ""), NONE, isKeptDrafts);
  const set = useCallback((id: string, kept: KeptDraft | null) => (who ? write((all) => withKept(all, id, kept)) : undefined), [who, write]);
  return { drafts: who ? drafts : NONE, set };
}
