/**
 * Which sides of a box that scrolls sideways hold more than is shown: what a table in an agent's reply shades, so a
 * reader on a phone sees there is more to its side. A pixel of slack either way is none: a browser's sub-pixel
 * widths leave a box scrolled to its end a fraction short.
 */
export function moreToTheSide(scrollLeft: number, scrollWidth: number, clientWidth: number): { start: boolean; end: boolean } {
  return { start: scrollLeft > 1, end: scrollLeft + clientWidth < scrollWidth - 1 };
}
