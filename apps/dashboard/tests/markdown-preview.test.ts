/**
 * A markdown file opened to read in the dashboard (0.8.11): a mission's `report.md`, and a `.md` file in a chat — the
 * owner asked to open the report as a preview, not download it.
 */

import { describe, expect, test } from "bun:test";
import { isMarkdownFile, PREVIEW_CHARS, previewOf, printPage } from "@/commons/components/ui/MarkdownPreview";

describe("which file is read as markdown", () => {
  test("by its type, or by its name where a platform sent it as bytes", () => {
    expect(isMarkdownFile("report.md", "text/markdown")).toBe(true);
    expect(isMarkdownFile("report.md", "text/markdown; charset=utf-8")).toBe(true);
    expect(isMarkdownFile("REPORT.MD", "application/octet-stream")).toBe(true);
    expect(isMarkdownFile("notes.markdown")).toBe(true);
    expect(isMarkdownFile("penjualan.csv", "text/csv")).toBe(false);
    expect(isMarkdownFile("report.md.pdf", "application/pdf")).toBe(false);
  });
});

describe("what the dialog shows of a file it read", () => {
  test("its text — and a file too long to show is saved instead, said so", () => {
    expect(previewOf("# Laporan\n\nSelesai.")).toEqual({ text: "# Laporan\n\nSelesai." });
    expect(previewOf("x".repeat(PREVIEW_CHARS + 1))).toEqual({ failure: "it is too long to show here; save it to read it" });
  });
});

describe("what Save as PDF prints", () => {
  test("the rendered file alone, as a document — named after the file, which the print dialog offers as the PDF's name", () => {
    const page = printPage("report.md", "<h1>Laporan</h1><p>Selesai.</p>");
    expect(page).toContain("<title>report</title>");
    expect(page).toContain("<body><h1>Laporan</h1><p>Selesai.</p></body>");
    // Black on white with a page's margins, whatever the dashboard's theme.
    expect(page).toContain("@page { margin: 18mm; }");
    expect(page).toContain("color: #111; background: #fff;");
    expect(printPage('a <b> & "c".md', "")).toContain("<title>a &lt;b&gt; &amp; &quot;c&quot;</title>");
  });
});
