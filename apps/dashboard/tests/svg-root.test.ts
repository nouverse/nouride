/**
 * An SVG's root tag given what a picture needs (`commons/components/ui/viewers/svg-root.ts`). A size: one that names
 * only its `viewBox`, or a width in percent as Mermaid writes, was drawn zero wide inside the button that opens it.
 * Its namespace: one written as it is inside a page of HTML was no picture to the browser, and stayed its code.
 * That it is then drawn is seen in a real browser; what is written into the SVG is held here.
 */

import { describe, expect, test } from "bun:test";
import { withNamespace, withSize } from "@/commons/components/ui/viewers/svg-root";

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

describe("an svg's namespace, before it is drawn", () => {
  test("one with none is given it on its root tag, and nothing else of it changes", () => {
    expect(withNamespace("<svg viewBox='0 0 40 20'><rect width='40' height='20'/></svg>")).toBe("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox='0 0 40 20'><rect width='40' height='20'/></svg>");
    // After what stands before the tag, and the tag's own spelling kept.
    expect(withNamespace("<!-- a logo -->\n<SVG><circle/></SVG>")).toBe('<!-- a logo -->\n<SVG xmlns="http://www.w3.org/2000/svg"><circle/></SVG>');
  });

  test("one that names it is as it was, and so is a text with no svg in it", () => {
    for (const svg of ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>', "<svg xmlns='http://www.w3.org/2000/svg'><svg/></svg>", "graph TD; A-->B", ""]) expect(withNamespace(svg)).toBe(svg);
  });

  test("a link's namespace on the root is not the picture's: it still gets its own", () => {
    expect(withNamespace('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>');
  });
});
