/**
 * Which text names a file of this machine's data folder (`commons/lib/data-folder.ts`): what is made a link to
 * System's Files, and what is left as the text it was.
 */

import { describe, expect, test } from "bun:test";
import { underDataFolder } from "@/commons/lib/data-folder";

const FOLDER = "/srv/nouride/.nouride";
const at = (text: string) => underDataFolder(text, FOLDER);

describe("a path of the data folder", () => {
  test("by the folder's own path on this machine, or by the folder's name alone", () => {
    expect(at("/srv/nouride/.nouride/workspace/shared/report.md")).toBe("workspace/shared/report.md");
    expect(at(".nouride/workspace/shared/report.md")).toBe("workspace/shared/report.md");
    expect(at("~/.nouride/agents/nouva/MEMORY.md")).toBe("agents/nouva/MEMORY.md");
    expect(at("./.nouride/config.toml")).toBe("config.toml");
    expect(at("  .nouride/workspace/a b/notes.md  ")).toBe("workspace/a b/notes.md");
    // A folder, with or without the slash after it.
    expect(at("/srv/nouride/.nouride/workspace/shared/")).toBe("workspace/shared");
    expect(underDataFolder("/srv/nouride/.nouride/x.md", "/srv/nouride/.nouride/")).toBe("x.md");
  });

  test("what follows a path is not part of it: a line number, a sentence's full stop, a closing bracket", () => {
    expect(at(".nouride/workspace/src/index.ts:42")).toBe("workspace/src/index.ts");
    expect(at(".nouride/workspace/src/index.ts:42:7")).toBe("workspace/src/index.ts");
    expect(at(".nouride/workspace/report.md.")).toBe("workspace/report.md");
    expect(at("/srv/nouride/.nouride/workspace/report.md),")).toBe("workspace/report.md");
  });

  test("anything else is not: another folder, a path that climbs out, the folder alone, a line of prose, an address", () => {
    for (const text of [
      "/etc/passwd",
      "/srv/nouride/.nouride",
      "/srv/nouride/.nouride/",
      ".nouride/",
      "/srv/nouride/.nourideX/workspace/x.md",
      "/home/other/.nouride/workspace/x.md",
      ".nouride/workspace/../data/.control-token",
      ".nouride/./x",
      ".nouride//x",
      "see .nouride/workspace/x.md for more",
      "https://example.com/.nouride/x",
      "workspace/x.md",
      "",
      `.nouride/${"a/".repeat(250)}x`,
      ".nouride/workspace/x.md\nrm -rf",
    ])
      expect({ text, path: at(text) }).toEqual({ text, path: null });
  });

  test("a reader the daemon does not tell where the folder is has no link at all", () => {
    expect(underDataFolder(".nouride/workspace/report.md", null)).toBeNull();
    expect(underDataFolder("/srv/nouride/.nouride/workspace/report.md", null)).toBeNull();
  });
});
