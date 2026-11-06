/**
 * Narrow a list by what is typed, on the page: every word must appear in one of the fields named.
 * Case-insensitive; an empty query keeps everything. For lists the page already holds in full.
 */

import { useMemo } from "react";

export function useTextFilter<T>(items: readonly T[], query: string, fields: (item: T) => (string | null | undefined)[]): T[] {
  return useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [...items];
    return items.filter((item) => {
      const haystack = fields(item).filter(Boolean).join(" ").toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    // `fields` is a selector written inline at the call site; the list and the query are what change.
  }, [items, query]);
}
