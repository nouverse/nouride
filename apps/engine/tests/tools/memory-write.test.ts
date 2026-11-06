/**
 * `memory_write` on an agent's own `MEMORY.md`, and the two ways a live one went wrong.
 *
 * Both were read off a box, in one agent's file. A section sent whole — heading included, which is
 * how a model writes one — landed *under* the existing heading, so it read back as two; the next
 * replace rewrote only the first, empty one, and every older version stayed below. One checkpoint was
 * in the file four times, and one status three times with three different answers. And a replace
 * that changed one line of `## Hardware` sent only that line: the PC, the phone and the server
 * described beside it were gone, behind a result that said "Memory updated".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryWriteTool } from "@/modules/tools/builtins/memory.ts";

let dir: string;
const file = () => join(dir, "MEMORY.md");
const read = () => readFileSync(file(), "utf8");
const ctx = () => ({ agentId: "nouva", agentDir: dir, gatewayId: "telegram:nouva", senderId: "1", chatId: "1", signal: new AbortController().signal }) as never;
const write = (args: Record<string, unknown>) => createMemoryWriteTool().execute(args, ctx());
const headings = (text: string, name: string) => text.split("\n").filter((line) => line.replace(/^#+\s*/, "").startsWith(name) && line.startsWith("#")).length;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-memory-md-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const START = "# MEMORY\n\n## Hardware\n\n- Home PC: Ryzen 7.\n- Phone: Redmi 12.\n- Server: Geekom A5.\n\n## Projects\n\n- LedgerLab: commit aaa111.\n";

describe("a section sent whole, heading and all", () => {
  test("replaces the section rather than nesting a second copy of its heading", async () => {
    writeFileSync(file(), START);
    const result = await write({ mode: "replace_section", section: "Projects", content: "## Projects\n\n- LedgerLab: commit bbb222." });
    expect(result.isError).toBe(false);
    expect(headings(read(), "Projects")).toBe(1);
    expect(read()).toContain("bbb222");
    expect(read()).not.toContain("aaa111");
  });

  test("three updates in a row leave one section and only the latest of it", async () => {
    writeFileSync(file(), START);
    for (const commit of ["bbb222", "ccc333", "ddd444"]) {
      await write({ mode: "replace_section", section: "Projects", content: `## Projects\n\n- LedgerLab: commit ${commit}.` });
    }
    expect(headings(read(), "Projects")).toBe(1);
    expect(read()).toContain("ddd444");
    for (const stale of ["aaa111", "bbb222", "ccc333"]) expect(read()).not.toContain(stale);
  });

  test("a heading that reads differently renames the section, at its own depth", async () => {
    // The dated checkpoint headings on the box: `(2026-10-05)`, then `(2026-10-06)`, each left behind empty.
    writeFileSync(file(), "# MEMORY\n\n## Checkpoint (2026-10-05)\n\n- Step one.\n");
    await write({ mode: "replace_section", section: "Checkpoint (2026-10-05)", content: "# Checkpoint (2026-10-06)\n\n- Step two." });
    expect(read()).toBe("# MEMORY\n\n## Checkpoint (2026-10-06)\n\n- Step two.\n");
  });

  test("a deeper heading first is a subsection, and the section keeps its own", async () => {
    writeFileSync(file(), START);
    await write({ mode: "replace_section", section: "Projects", content: "### LedgerLab\n\n- commit bbb222." });
    expect(read()).toContain("## Projects\n\n### LedgerLab\n\n- commit bbb222.");
  });
});

describe("append", () => {
  test("a block opening with a heading the file already has is refused, and the file left alone", async () => {
    writeFileSync(file(), START);
    const result = await write({ mode: "append", content: "## Hardware\n\n- Laptop: MacBook Air." });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('replace_section with section="Hardware"');
    expect(read()).toBe(START);
  });

  test("a new heading, or none, still appends", async () => {
    writeFileSync(file(), START);
    expect((await write({ mode: "append", content: "## Media\n\n- Dapur Teknologi." })).isError).toBe(false);
    expect((await write({ mode: "append", content: "- A loose line." })).isError).toBe(false);
    expect(read().endsWith("## Media\n\n- Dapur Teknologi.\n\n- A loose line.\n")).toBe(true);
  });
});

describe("a replace that takes most of a section with it", () => {
  test("says how much went, where the agent reads it", async () => {
    const machines = ["Home PC: Ryzen 7.", "Wake-on-LAN: magic packet.", "Phone: Redmi 12.", "ADB over Wi-Fi.", "Server: Geekom A5.", "UPS: 900 W."];
    writeFileSync(file(), `# MEMORY\n\n## Hardware\n\n${machines.map((line) => `- ${line}`).join("\n")}\n`);
    const result = await write({ mode: "replace_section", section: "Hardware", content: "- Laptop: MacBook Air, KeepAwake on." });
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/5 lines shorter/);
    expect(result.content).toContain("write it again whole");
    expect(result.metadata).toMatchObject({ removed: 5 });
  });

  test("a line or two dropped on purpose is not worth a warning", async () => {
    writeFileSync(file(), START);
    const result = await write({ mode: "replace_section", section: "Hardware", content: "- Home PC: Ryzen 7." });
    expect(result.content).not.toContain("shorter");
  });

  test("a section rewritten at its own size says nothing about it", async () => {
    writeFileSync(file(), START);
    const result = await write({ mode: "replace_section", section: "Hardware", content: "- Home PC: Ryzen 7, RTX 5060 Ti.\n- Phone: Redmi 12.\n- Server: Geekom A5." });
    expect(result.content).not.toContain("shorter");
  });
});

describe("what the tool tells the model", () => {
  test("its own notes are never where facts about a person go", () => {
    const tool = createMemoryWriteTool({} as never);
    expect(tool.definition.description).toContain("never facts about a person");
    expect(tool.definition.description).toContain("sent whole");
  });
});
