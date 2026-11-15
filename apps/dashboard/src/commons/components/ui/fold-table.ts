/**
 * A table on a phone, by one rule (`table-fold.test.ts` finds a table that folds any other way). From a phone's width
 * up (`sm`) it is the table it is. Below it the header goes, and each row is a block of lines: the cells that matter
 * most take a line each (`whole`), and the short ones sit side by side on a line between them (`cell`), each named by a
 * word of its own where the header would have named it (`label`). Five columns scrolling sideways inside a card was a
 * table read through a slot, with the name of a row out of sight by its third column.
 *
 * Groups, People, Users, the audit log and Home's use by route. A table in an agent's reply cannot fold, since its
 * columns are the agent's: it scrolls in its box.
 */

export const FOLD = {
  table: "table w-full max-sm:block",
  head: "max-sm:hidden",
  body: "max-sm:block",
  row: "max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1.5 max-sm:px-4 max-sm:py-3",
  /** A short cell: on a phone it sits beside the cells around it. */
  cell: "max-sm:border-0 max-sm:p-0",
  /** A cell that takes a line of its own on a phone: the row's name, a long value, what can be done to it. */
  whole: "max-sm:min-w-0 max-sm:basis-full max-sm:border-0 max-sm:p-0",
  /** What a cell is, said on a phone, where no header says it. */
  label: "sm:hidden",
} as const;
