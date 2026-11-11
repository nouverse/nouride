/**
 * What the page on screen says of itself, for the chat that floats over it: what it is called (`PageHeader` says its
 * title, so a page with one says nothing more) and the one thing it is about, where it is about one:
 * `usePageSubject("Shop health check")` on a job's page, a mission's goal on its page, an agent's name on its pages.
 * The floating chat sends both with a message (`page-open.ts`), and the agent is told which page the person has open.
 *
 * Said while the page is drawn and taken back when it goes. Read when a message is sent, never drawn, so nothing
 * listens to it.
 */

import { useEffect } from "react";

type Part = "title" | "subject";

/** Who said each part, and what: a page that goes takes back only what is still its own. */
const said: Partial<Record<Part, { by: symbol; words: string }>> = {};

function useSaid(part: Part, words: string | undefined): void {
  useEffect(() => {
    const text = words?.trim();
    if (!text) return undefined;
    const by = Symbol(part);
    said[part] = { by, words: text };
    return () => {
      // The next page may have said its own already: its words stay.
      if (said[part]?.by === by) delete said[part];
    };
  }, [part, words]);
}

/** What the page is called. `PageHeader` calls it; a page with a header of its own may. */
export function usePageTitle(title: string | undefined): void {
  useSaid("title", title);
}

/** The one thing the page is about, once it is known: nothing is said while it loads. */
export function usePageSubject(subject: string | undefined): void {
  useSaid("subject", subject);
}

/** What the page on screen has said of itself. */
export function pageSaid(): { title?: string; subject?: string } {
  return { ...(said.title ? { title: said.title.words } : {}), ...(said.subject ? { subject: said.subject.words } : {}) };
}
