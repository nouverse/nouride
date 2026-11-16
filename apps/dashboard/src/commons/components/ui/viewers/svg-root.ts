/**
 * An SVG's root tag given what a picture needs, before the SVG is drawn as one: a size and its namespace.
 *
 * One that names only its `viewBox`, or a width in percent as Mermaid writes, has a shape and no size. As an `<img>`
 * inside a box that takes its width from the picture (the button a press opens it large with), the browser draws it
 * zero wide: the block was there, with its switch and its copy button, and nothing in it. Its `viewBox`'s width and
 * height are written as its size, so it is drawn that large and, by the picture's own classes, no wider than the page.
 *
 * And one written as it is inside a page of HTML, `<svg viewBox=…>` with no `xmlns`, is no picture to a browser at
 * all: a file of its own must say what its tags are. It stayed the code it was, with nothing wrong in it.
 *
 * Only the root tag is read, as text: the SVG is never parsed into the page.
 */

/** A length with a size of its own: a number, with or without a unit. A percent is a share of something else. */
const LENGTH = /^\s*\d*\.?\d+\s*(px|pt|pc|mm|cm|in|em|ex|rem)?\s*$/i;

/** An attribute of a tag, by name: its value, or null. The space before the name keeps `stroke-width` out of `width`. */
function attribute(tag: string, name: string): string | null {
  const found = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return found ? (found[1] ?? found[2] ?? "") : null;
}

function without(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "i"), "");
}

/** The SVG with its `viewBox`'s size as its own, where it had none; as it was where it has one, or no `viewBox`. */
export function withSize(svg: string): string {
  const root = /<svg\b[^>]*>/i.exec(svg);
  if (!root) return svg;
  const tag = root[0];
  // One side is enough: with a `viewBox` the browser reads the other from its shape.
  if ([attribute(tag, "width"), attribute(tag, "height")].some((value) => value !== null && LENGTH.test(value))) return svg;
  const box = (attribute(tag, "viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const [, , width, height] = box;
  if (box.length !== 4 || !box.every(Number.isFinite) || !(width! > 0) || !(height! > 0)) return svg;
  const sized = without(without(tag, "width"), "height").replace(/^<svg\b/i, (name) => `${name} width="${width}" height="${height}"`);
  return svg.slice(0, root.index) + sized + svg.slice(root.index + tag.length);
}

/** The SVG with its namespace on its root tag, where it named none: without it a browser reads no picture in the file. */
export function withNamespace(svg: string): string {
  const root = /<svg\b[^>]*>/i.exec(svg);
  if (!root || attribute(root[0], "xmlns") !== null) return svg;
  return svg.slice(0, root.index) + root[0].replace(/^<svg\b/i, (name) => `${name} xmlns="http://www.w3.org/2000/svg"`) + svg.slice(root.index + root[0].length);
}
