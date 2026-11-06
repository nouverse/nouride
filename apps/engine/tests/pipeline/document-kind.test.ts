/**
 * What `read` says when it is handed something that is not text.
 *
 * The failure this replaces was watched live: handed a PDF, the agent got the bytes back, guessed
 * `pdftotext`, hit `Executable not found in $PATH`, then wrote a `python3 -c` script against `pypdf`
 * from memory. It got there — which is why nobody noticed — at the cost of a failed call and an
 * unreviewed script on every document.
 */

import { describe, expect, test } from "bun:test";
import {
  binaryReadMessage,
  documentKindFor,
  documentReadMessage,
  looksBinary,
} from "@/modules/tools/builtins/document-kind.ts";

describe("classifying by extension", () => {
  test.each([
    ["paper.pdf", "PDF"],
    ["brief.DOCX", "Word document"],
    ["budget.xlsx", "spreadsheet"],
    ["deck.pptx", "presentation"],
    ["book.epub", "e-book"],
    ["logs.tar.gz", "archive"],
    ["screenshot.png", "image"],
  ])("%s is a %s", (path, kind) => {
    expect(documentKindFor(path)?.kind).toBe(kind);
  });

  test("case does not matter, because a filename's case never does", () => {
    expect(documentKindFor("/tmp/REPORT.PDF")?.kind).toBe("PDF");
  });

  test("text files are left alone", () => {
    for (const path of ["notes.md", "main.ts", "data.json", "log.txt", "config.toml", "q.csv"]) {
      expect(documentKindFor(path)).toBeNull();
    }
  });

  test("a CSV is not a spreadsheet", () => {
    // It is text, and `read` handles it. Routing it through a converter would make the agent shell out
    // for a file it could already open.
    expect(documentKindFor("rows.csv")).toBeNull();
  });

  test("only documents point at the skill", () => {
    // Unpacking an archive is ordinary shell work and an image is something the model can look at.
    // Naming a document skill for either would send it to the wrong instructions.
    expect(documentKindFor("paper.pdf")?.skill).toBe(true);
    expect(documentKindFor("logs.zip")?.skill).toBe(false);
    expect(documentKindFor("photo.jpg")?.skill).toBe(false);
  });
});

describe("the message is a pointer, not a refusal", () => {
  test("it names what the file is, the first command, and the skill", () => {
    const message = documentReadMessage("paper.pdf", documentKindFor("paper.pdf")!);

    expect(message).toContain("is a PDF");
    // The concrete command, with the real path substituted — a shape to fill in is a shape to get
    // wrong, and this is the call that failed live.
    expect(message).toContain("pdftotext -layout 'paper.pdf'");
    expect(message).toContain("document-reading");
  });

  test("an archive gets shell advice and no skill reference", () => {
    const message = documentReadMessage("logs.tar", documentKindFor("logs.tar")!);

    expect(message).toContain("unpack it");
    expect(message).not.toContain("document-reading");
  });

  test("an image is pointed at looking rather than converting", () => {
    const message = documentReadMessage("shot.png", documentKindFor("shot.png")!);
    expect(message).toContain("attachment");
  });
});

describe("binary detection for files with unhelpful names", () => {
  const bytes = (...values: number[]) => new Uint8Array(values);

  test("a NUL byte means binary", () => {
    expect(looksBinary(bytes(0x25, 0x50, 0x44, 0x00))).toBe(true);
  });

  test("and nothing else does", () => {
    // Deliberately the only test. Counting "unusual" byte ratios rejects minified JavaScript, base64
    // and every non-Latin script, and a `read` that refuses a real file is worse than one that returns
    // something ugly.
    const utf8 = new TextEncoder().encode("halo — こんにちは — 🌌 minified:!function(e){}(0)");
    expect(looksBinary(utf8)).toBe(false);
    expect(looksBinary(new Uint8Array())).toBe(false);
  });

  test("its message says how to find out what the file is", () => {
    expect(binaryReadMessage("blob.dat")).toContain('["file","blob.dat"]');
  });
});
