import { describe, expect, test } from "bun:test";
import {
  buildApprovalPreview,
  isShellInvocation,
  previewHeadline,
} from "../src/approval-preview.ts";

const noFiles = { statFile: () => null };

describe("summarising a write", () => {
  test("an append to a file that is there adds lines and takes none away — an edit, not a replacement", () => {
    const existing = { statFile: () => ({ lines: 400, bytes: 12_000 }) };
    const preview = buildApprovalPreview("write", { path: "report.md", content: "## Part two\nmore\n", append: true }, existing);
    expect(preview).toMatchObject({ kind: "edit", path: "report.md", added: 2, removed: 0 });
    expect(previewHeadline(preview)).toBe("report.md · +2 −0");
    // Not there yet, it is created: a new file, as a write would be.
    expect(buildApprovalPreview("write", { path: "report.md", content: "x\n", append: true }, noFiles)).toMatchObject({ kind: "new_file" });
  });

  test("a new file is stats only — never its contents", () => {
    const content = "<!DOCTYPE html>\n<html>\n<body>hi</body>\n</html>\n";
    const preview = buildApprovalPreview("write", { path: "landing/index.html", content }, noFiles);

    expect(preview).toEqual({
      kind: "new_file",
      path: "landing/index.html",
      lines: 4,
      bytes: 47,
    });
    // The whole point: the file body must not travel in the summary.
    expect(JSON.stringify(preview)).not.toContain("DOCTYPE");
  });

  test("counts lines the way wc -l does", () => {
    const trailing = buildApprovalPreview("write", { path: "a", content: "one\ntwo\n" }, noFiles);
    const noTrailing = buildApprovalPreview("write", { path: "a", content: "one\ntwo" }, noFiles);
    const empty = buildApprovalPreview("write", { path: "a", content: "" }, noFiles);

    // A trailing newline terminates the last line rather than starting an empty one.
    expect(trailing).toMatchObject({ lines: 2 });
    expect(noTrailing).toMatchObject({ lines: 2 });
    expect(empty).toMatchObject({ lines: 0 });
  });

  test("bytes are bytes, not characters", () => {
    // Six characters, nine bytes. A count that measured characters would understate every file with an
    // accent or an arrow in it.
    const content = "héllo→";
    expect(content.length).toBe(6);
    const preview = buildApprovalPreview("write", { path: "a", content }, noFiles);

    expect(preview).toMatchObject({ bytes: 9 });
  });

  test("an existing file leads with what is being lost", () => {
    const preview = buildApprovalPreview(
      "write",
      { path: "app.js", content: "console.log(1);\n" },
      { statFile: () => ({ lines: 400, bytes: 12_000 }) },
    );

    expect(preview.kind).toBe("overwrite");
    const headline = previewHeadline(preview);
    // "replaces 400 lines with 1" is a different decision from "creates 1 line", and the old size has to
    // come first or the difference is invisible at a glance.
    expect(headline).toContain("replaces 400 lines");
    expect(headline.indexOf("400")).toBeLessThan(headline.indexOf("1 line"));
  });

  test("an uncounted old file reports bytes rather than inventing a line count", () => {
    const preview = buildApprovalPreview(
      "write",
      { path: "big.log", content: "x\n" },
      { statFile: () => ({ lines: -1, bytes: 50 * 1024 * 1024 }) },
    );

    const headline = previewHeadline(preview);
    expect(headline).toContain("50.0MB");
    expect(headline).not.toContain("-1");
  });
});

describe("summarising an edit", () => {
  test("shows the change itself", () => {
    const preview = buildApprovalPreview(
      "edit",
      { path: "a.ts", old_string: "const x = 1;", new_string: "const x = 2;\nconst y = 3;" },
      noFiles,
    );

    expect(preview).toEqual({
      kind: "edit",
      path: "a.ts",
      removed: 1,
      added: 2,
      hunk: [
        { sign: "-", text: "const x = 1;" },
        { sign: "+", text: "const x = 2;" },
        { sign: "+", text: "const y = 3;" },
      ],
      clipped: false,
    });
    expect(previewHeadline(preview)).toBe("a.ts · +2 −1");
  });

  test("a large edit is split between what goes and what arrives", () => {
    const old = Array.from({ length: 50 }, (_, i) => `old ${i}`).join("\n");
    const next = Array.from({ length: 50 }, (_, i) => `new ${i}`).join("\n");
    const preview = buildApprovalPreview("edit", { path: "a", old_string: old, new_string: next }, noFiles);

    if (preview.kind !== "edit") throw new Error("expected an edit");
    expect(preview.clipped).toBe(true);
    // Both sides present. Showing 14 removed lines and no added ones tells the operator what they are
    // losing and nothing about what they are getting.
    expect(preview.hunk.some((l) => l.sign === "-")).toBe(true);
    expect(preview.hunk.some((l) => l.sign === "+")).toBe(true);
    expect(preview.hunk.length).toBeLessThanOrEqual(14);
    // Counts describe the whole change, not the shown part.
    expect(preview.removed).toBe(50);
    expect(preview.added).toBe(50);
  });

  test("a deletion is an edit with nothing arriving", () => {
    const preview = buildApprovalPreview("edit", { path: "a", old_string: "gone", new_string: "" }, noFiles);

    expect(preview).toMatchObject({ removed: 1, added: 0 });
    if (preview.kind !== "edit") throw new Error("expected an edit");
    expect(preview.hunk).toEqual([{ sign: "-", text: "gone" }]);
  });
});

describe("summarising everything else", () => {
  test("a command is shown the way a shell would", () => {
    const preview = buildApprovalPreview("exec", { command: ["bun", "test", "--bail"] }, noFiles);

    expect(preview).toEqual({ kind: "command", command: "bun test --bail", clipped: false });
    expect(previewHeadline(preview)).toBe("bun test --bail");
  });

  test("an over-long command is marked clipped rather than silently shortened", () => {
    const preview = buildApprovalPreview("exec", { command: "x".repeat(500) }, noFiles);

    if (preview.kind !== "command") throw new Error("expected a command");
    expect(preview.clipped).toBe(true);
    // A shortened command nobody is told was shortened is not something anyone can approve.
    expect(previewHeadline(preview)).toContain("clipped");
  });

  test("an unfamiliar tool falls back to compact JSON", () => {
    const preview = buildApprovalPreview("web_fetch", { url: "https://example.com" }, noFiles);

    expect(preview).toEqual({
      kind: "params",
      json: '{"url":"https://example.com"}',
      clipped: false,
    });
  });

  test("shape decides, not the tool name", () => {
    // A future tool that takes path + content gets a readable prompt without being listed anywhere.
    const preview = buildApprovalPreview("scaffold_project", { path: "a.txt", content: "hi\n" }, noFiles);

    expect(preview.kind).toBe("new_file");
  });
});

describe("the sizes a headline gives", () => {
  // The preview had a byte formatter of its own that stopped at megabytes: a 2 GB file read "2048.0 MB" (0.8.17).
  test("are formatBytes', gigabytes included", () => {
    const preview = buildApprovalPreview(
      "write",
      { path: "dump.sql", content: "x\n".repeat(1536) },
      { statFile: () => ({ lines: -1, bytes: 2 * 1024 ** 3 }) },
    );
    expect(previewHeadline(preview)).toBe("dump.sql · replaces 2.0GB with 1536 lines (3KB)");
    const created = buildApprovalPreview("write", { path: "a.txt", content: "hello\n" }, noFiles);
    expect(previewHeadline(created)).toBe("a.txt · new file · 1 lines, 6B");
  });
});

describe("shell invocations", () => {
  test("a shell running a string is marked as one", () => {
    // `sh -c "…"` and `ls -la` read equally tidily in a prompt and are not equally reviewable: the
    // second half of a shell line is a program in its own right.
    const preview = buildApprovalPreview(
      "exec",
      { command: ["sh", "-c", "kubectl get po | grep -v Running"] },
      {} as never,
    );
    expect(preview).toMatchObject({ kind: "command", shell: true });
  });

  test("a shell running a file is not — the grant already hashes that file", () => {
    expect(
      buildApprovalPreview("exec", { command: ["bash", "deploy.sh"] }, {} as never),
    ).not.toMatchObject({ shell: true });
  });

  test("the interpreter is matched by basename, not by spelling", () => {
    expect(
      buildApprovalPreview("exec", { command: ["/bin/bash", "-c", "echo hi"] }, {} as never),
    ).toMatchObject({ shell: true });
  });

  test("isShellInvocation covers the usual interpreters and nothing else", () => {
    for (const shell of ["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]) {
      expect(isShellInvocation([shell, "-c", "x"])).toBe(true);
    }
    expect(isShellInvocation(["python", "-c", "print(1)"])).toBe(false);
    expect(isShellInvocation(["sh"])).toBe(false);
    expect(isShellInvocation("sh -c x")).toBe(false);
  });
});
