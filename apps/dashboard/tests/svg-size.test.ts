/**
 * An SVG given a size before it is drawn as a picture (`commons/components/ui/viewers/svg-size.ts`): one that names
 * only its `viewBox`, or a width in percent as Mermaid writes, was drawn zero wide inside the button that opens it.
 * That it is then drawn at that size is seen in a real browser; what is written into the SVG is held here.
 */

import { describe, expect, test } from "bun:test";
import { withSize } from "@/commons/components/ui/viewers/svg-size";

describe("an svg's size, before it is drawn", () => {
  test("one that names only its viewBox takes the viewBox's width and height as its own", () => {
    expect(withSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><rect/></svg>')).toBe('<svg width="200" height="80" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><rect/></svg>');
    // Commas between the numbers, single quotes, and a first line before the tag.
    expect(withSize("<?xml version='1.0'?>\n<svg viewBox='10,20,64.5,32'/>")).toBe("<?xml version='1.0'?>\n<svg width=\"64.5\" height=\"32\" viewBox='10,20,64.5,32'/>");
  });

  test("Mermaid's own, a width of 100%: the percent goes and the viewBox's size is written, its style kept", () => {
    const made = '<svg id="nr-mermaid-1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 512.3px;" viewBox="0 0 512.3 162" role="graphics-document document"><g/></svg>';
    const sized = withSize(made);
    expect(sized.startsWith('<svg width="512.3" height="162" id="nr-mermaid-1" xmlns=')).toBe(true);
    expect(sized).not.toContain('width="100%"');
    expect(sized).toContain('style="max-width: 512.3px;"');
    expect(sized.endsWith("<g/></svg>")).toBe(true);
  });

  test("one with a size of its own is as it was: both sides, or one side beside a viewBox, in any unit", () => {
    for (const svg of ['<svg width="40" height="40"><circle/></svg>', '<svg width="12em" viewBox="0 0 200 80"/>', '<svg height="3.5in" viewBox="0 0 200 80"/>', '<svg width=".5cm" height="100%" viewBox="0 0 200 80"/>']) expect(withSize(svg)).toBe(svg);
  });

  test("a stroke's width is not the picture's, and only the first tag is changed", () => {
    expect(withSize('<svg stroke-width="2" viewBox="0 0 10 10"><svg width="100%" viewBox="0 0 5 5"/></svg>')).toBe('<svg width="10" height="10" stroke-width="2" viewBox="0 0 10 10"><svg width="100%" viewBox="0 0 5 5"/></svg>');
  });

  test("with no viewBox to read, or one that is no size, it is as it was", () => {
    for (const svg of ["<svg><rect/></svg>", '<svg width="100%"><rect/></svg>', '<svg viewBox="0 0 0 80"/>', '<svg viewBox="0 0 200"/>', '<svg viewBox="0 0 200 80 5"/>', '<svg viewBox="0 0 wide tall"/>', '<svg viewBox="0 0 -200 80"/>', "graph TD; A-->B", ""]) expect(withSize(svg)).toBe(svg);
  });
});
