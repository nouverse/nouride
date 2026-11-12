/**
 * A list put in another order by dragging one of its items: where the item lands, and how far the others move out of
 * its way while it is held. Pure, so the decisions are tested without a pointer (`tests/reorder.test.ts`);
 * `ReorderList` draws them.
 */

/** One item's place down the list: where it starts and how tall it is. */
export interface Slot {
  top: number;
  height: number;
}

/** The list with one item taken from `from` and put at `to`, the place it ends up at. */
export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items];
  const rest = items.filter((_, at) => at !== from);
  return [...rest.slice(0, to), items[from]!, ...rest.slice(to)];
}

/**
 * Where an item dragged `dy` from its place lands: past every item whose middle its own middle has gone below. So an
 * item takes a neighbour's place once it is more than halfway over it, and not before.
 */
export function dropIndex(slots: readonly Slot[], from: number, dy: number): number {
  const held = slots[from];
  if (!held) return from;
  const middle = held.top + held.height / 2 + dy;
  let index = 0;
  slots.forEach((slot, at) => {
    if (at !== from && slot.top + slot.height / 2 < middle) index += 1;
  });
  return index;
}

/** How far the item at `index` stands aside while the one from `from` is held over `over`: by the held one's height. */
export function shiftOf(index: number, from: number, over: number, size: number): number {
  if (index === from) return 0;
  if (from < over && index > from && index <= over) return -size;
  if (over < from && index >= over && index < from) return size;
  return 0;
}
