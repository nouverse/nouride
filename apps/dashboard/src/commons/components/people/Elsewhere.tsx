/**
 * What an admin's own list leaves out, said under it: how many more there are that are other people's or nobody's, and
 * the press that lists them (Automations, Missions). An admin's list is their own until they pick otherwise, so a
 * page that lists three where there are ten reads as seven gone, most of all on a list with none of their own.
 *
 * The count is the daemon's, sent to an admin whose list is their own and only when there is more: nobody else is told
 * that what they cannot see exists.
 */

export const elsewhereWords = (count: number): string => (count === 1 ? "1 more belongs to someone else or to nobody." : `${count} more belong to other people or to nobody.`);

/** The press that sets the page's picker to Everyone. */
export function ShowEveryone({ onPress }: { onPress: () => void }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm border border-base-content/10" onClick={onPress}>
      Show everyone
    </button>
  );
}

/** The line under a list that has rows of the reader's own. An empty list says the same in its empty state. */
export function Elsewhere({ count, onEveryone }: { count: number; onEveryone: () => void }) {
  return (
    <p data-elsewhere={count} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 text-sm text-base-content/65">
      {elsewhereWords(count)}
      <ShowEveryone onPress={onEveryone} />
    </p>
  );
}
