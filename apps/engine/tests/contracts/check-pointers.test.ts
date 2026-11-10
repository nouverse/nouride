/**
 * `scripts/check-pointers.ts` holds every pointer in a comment or a doc to something that exists, and every doc block
 * to a declaration. Each rule is pinned from both sides — a pointer that resolves passes, one that does not is named —
 * over a made-up tree, so a rule that stopped matching would fail here rather than pass the real tree by finding
 * nothing. The last test is the real tree.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, check, indexOf, isDoc, isIgnored, linkProblems, pointerProblems, siteAnchors, slug, stackedDocBlocks, type Index } from "../../../../scripts/check-pointers.ts";
import { commandLines, commandProblem } from "../../../../scripts/pointers/commands.ts";
import { MAPS_RETIRED_EDITIONS, retiredEditionLines, staleEditionMaps } from "../../../../scripts/pointers/editions.ts";

const ROOT = join(import.meta.dir, "../../../..");

/** A tree of `files`, with `absent` standing for a submodule that is not checked out. */
function tree(files: Record<string, string>, absent: string[] = []): Index {
  const { dirs, byBase } = indexOf(Object.keys(files));
  return { files: new Set(Object.keys(files)), dirs, byBase, absent, verbs: new Set(["status", "agents"]), ignored: (rel) => rel.startsWith("apps/engine/tmp"), read: (rel) => files[rel] };
}

const TREE = tree({
  "apps/engine/src/modules/turns/turns.store.ts": "export class TurnStore { inserted() {} }",
  "scripts/build/core.ts": "export function run() {}",
  "docs/SPEC.md": "# Spec\n\n## 6. LLM Executor\n\n### 6.3 System Prompt Builder\n",
  "docs/CLI.md": "# CLI\n\n## `nouride chat`\n\n```\n## not a heading\n```\n",
});

const rules = (index: Index, text: string, from = "apps/x.ts"): string[] => pointerProblems(index, text, from).map((f) => `${f.rule}: ${f.detail}`);

describe("paths", () => {
  test("a tracked file or directory passes; one that is not is named", () => {
    expect(rules(TREE, "see `scripts/build/core.ts` and apps/engine/src/modules/turns/")).toEqual([]);
    expect(rules(TREE, "see scripts/build-binary.ts")).toEqual(["path: `scripts/build-binary.ts` is not a tracked file or directory"]);
  });

  test("a glob, a placeholder or a URL is not a pointer", () => {
    expect(rules(TREE, "apps/*/src, packages/<name>/src, https://example.com/docs/x.md")).toEqual([]);
  });

  test("an ignored path is somewhere — a scratch directory, a build output", () => {
    expect(rules(TREE, "write it in apps/engine/tmp/live.ts")).toEqual([]);
  });

  test("a path into a submodule that is not checked out is not judged", () => {
    expect(rules(tree({}, ["internals/pro/"]), "internals/pro/packages/appliance/src/gone.ts")).toEqual([]);
    expect(rules(tree({}), "internals/pro/packages/appliance/src/gone.ts")).toHaveLength(1);
  });
});

describe("where a path is read from", () => {
  const PRO = tree({ "internals/pro/docs/RUNBOOK.md": "", "internals/pro/packages/appliance/scripts/build-ui.ts": "", "docs/SPEC.md": "# Spec" });

  test("inside Pro, from the root, Pro's root or the package the file is in", () => {
    expect(rules(PRO, "see docs/RUNBOOK.md and docs/SPEC.md", "internals/pro/scripts/e2e/README.md")).toEqual([]);
    expect(rules(PRO, "`scripts/build-ui.ts` inlines it", "internals/pro/packages/appliance/vite.config.ts")).toEqual([]);
    expect(rules(PRO, "see docs/GONE.md", "internals/pro/docs/X.md")).toEqual(["path: `docs/GONE.md` is not a tracked file or directory"]);
  });

  test("outside it, from the root only", () => {
    expect(rules(PRO, "see docs/RUNBOOK.md", "docs/README.md")).toEqual(["path: `docs/RUNBOOK.md` is not a tracked file or directory"]);
  });

  test("an ignored directory that was never built is still ignored", () => {
    // `dist/` matches only a directory, and git cannot tell an absent path is one: a fresh clone failed on
    // `apps/dashboard/dist` while one that had built the dashboard passed.
    const dir = mkdtempSync(join(tmpdir(), "pointers-ignore-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, ".gitignore"), "out/\n");
      expect(existsSync(join(dir, "out"))).toBe(false);
      expect(isIgnored(dir, "out")).toBe(true);
      expect(isIgnored(dir, "src")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("which files are docs", () => {
  test("the site's pages and the Pro docs are; the register and the audit are records", () => {
    expect(isDoc("apps/site/src/content/docs/en/docs/cli/reference.md")).toBe(true);
    expect(isDoc("apps/site/src/content/docs/en/docs/start/install.mdx")).toBe(true);
    expect(isDoc("internals/pro/docs/DISTRIBUTION.md")).toBe(true);
    expect(isDoc("internals/pro/scripts/e2e/README.md")).toBe(true);
    expect(isDoc("internals/pro/docs/archive/v0.7.x_tech_debt/REGISTER_99.md")).toBe(false);
    expect(isDoc("internals/pro/docs/archive/v0.7.x_tech_debt/README.md")).toBe(false);
    expect(isDoc("internals/pro/docs/rfc/v0.8.x_RFC_SMART_AUTOMATION.md")).toBe(false);
    expect(isDoc("internals/pro/docs/archive/rfc/v0.8.0_RFC_MISSIONS.md")).toBe(false);
    expect(isDoc("docs/archive/IMPROVEMENT_PROPOSALS.md")).toBe(false);
  });

  test("a link the site fills in at build time is not a file", () => {
    expect(linkProblems(TREE, "[x64](@@TARBALL_BASE@@/nouride-linux-x64.tar.gz)", "apps/site/src/content/docs/en/docs/x.md")).toEqual([]);
  });
});

describe("nouride lines", () => {
  const VERBS = new Set(["service", "cron", "memory", "config", "agents", "access", "pkg", "chat", "update"]);
  const said = (text: string, markdown = false): string[] =>
    commandLines(text, markdown).flatMap((line) => commandProblem(line, VERBS) ?? []);

  test("a flag the command reads passes; one it does not is named, as the CLI would", () => {
    expect(said("run `nouride service uninstall --kind systemd`")).toEqual([]);
    expect(said("run `nouride service uninstall --dir /opt/x`")).toEqual(["`nouride service` does not read --dir here — the CLI refuses it with exit 2"]);
  });

  test("so is a word that is none of the command's actions", () => {
    expect(said("`nouride agents reload`")).toEqual(['`nouride agents` has no "reload" — the CLI refuses it with exit 2']);
    expect(said("`nouride config set security.exec.ask off`")).toEqual(['`nouride config` has no "set" — the CLI refuses it with exit 2']);
  });

  test("a line that shows the refusal on purpose says exit 2", () => {
    expect(said("`nouride memory pass --dry-run` is exit 2 now")).toEqual([]);
  });

  test("usage notation: a|b is either, each checked; [ ] is optional; a placeholder action is not judged", () => {
    expect(said("`nouride cron update <id> [--at|--every|--cron …]`")).toEqual([]);
    expect(said("`nouride cron add|update … --command`")).toEqual(["`nouride cron` does not read --command here — the CLI refuses it with exit 2"]);
    expect(said("`nouride access [pending|approved]` and `nouride pkg install|remove <name…>`")).toEqual([]);
    expect(said("`nouride agents <action> <id>`")).toEqual([]);
  });

  test("--json and --help are every command's, --flag=value is --flag value, and a shell operator ends the line", () => {
    expect(said("`nouride update --check --json` `nouride service uninstall --help` `nouride update --check=yes`")).toEqual([]);
    expect(said("`nouride chat > out.log 2>&1 &`")).toEqual([]);
  });

  test("in markdown, a fenced line that runs nouride is read, and a file listing is not", () => {
    const doc = "```sh\n$ sudo nouride service uninstall --dir /x   # prints it\nnouride               the executable\n```\n";
    expect(said(doc, true)).toEqual(["`nouride service` does not read --dir here — the CLI refuses it with exit 2"]);
    expect(said("```sh\nnouride activity\n```\n", true)).toEqual(["`nouride activity` is not a command the CLI dispatches"]);
    expect(said(doc, false)).toEqual([]);
  });
});

describe("retired edition names", () => {
  test("named anywhere but where they are mapped, by line", () => {
    expect(retiredEditionLines("docs/X.md", "the free edition\nbuild it with --device-pro\nthe Cloud edition\n")).toEqual([2, 3]);
    expect(retiredEditionLines("docs/X.md", "EDITION=cloud bun run build")).toEqual([1]);
    expect(retiredEditionLines(Object.keys(MAPS_RETIRED_EDITIONS)[0]!, "--device-pro")).toEqual([]);
  });

  test("Pro Router too, since 0.7.20, in each spelling it was used in", () => {
    const spellings = ["build:pro --pro-router", "nouride-pro-router-linux-x64.tar.gz", "SHA256SUMS-pro-router", '"pro-router"', "the Pro Router edition"];
    expect(retiredEditionLines("docs/X.md", spellings.join("\n"))).toEqual([1, 2, 3, 4, 5]);
    // `pro` and `router` alone, and a Pro install with its gateway on, are today's words.
    expect(retiredEditionLines("docs/X.md", "--pro\n--router\nPro, with the LLM gateway on\nnouride-pro-linux-x64\n")).toEqual([]);
  });

  test("not words that are names of something else", () => {
    expect(retiredEditionLines("x.ts", 'run("nmcli", ["device", "status"]); approvals: "normal"; multi-device protocol, Nouverse Cloud')).toEqual([]);
  });

  test("an entry for a file that names none of them any more is stale; one for a submodule not checked out is not judged", () => {
    const [mapped] = Object.keys(MAPS_RETIRED_EDITIONS).filter((rel) => !rel.startsWith("internals/"));
    const read = (rel: string) => (rel === mapped ? "nothing old here" : "--device-pro");
    expect(staleEditionMaps(read, ["internals/pro/"])).toEqual([mapped!]);
  });
});

describe("bare file names", () => {
  test("must be some tracked file's name", () => {
    expect(rules(TREE, "`turns.store.ts` and `core.ts`")).toEqual([]);
    expect(rules(TREE, "`grant-store.ts` says why")).toEqual(["file-name: no tracked file is called `grant-store.ts`"]);
  });

  test("are not judged while a submodule is missing — the file may be in it", () => {
    expect(rules(tree({}, ["internals/pro/"]), "`identity.ts`")).toEqual([]);
  });

  test("judged with Nougate checked out or not: a name only Nougate has is not an answer either way", () => {
    // They used to be judged only while every submodule was there, so a hook run with Pro alone passed what the full
    // check failed. Nougate is another product: its files are named by path.
    const named = "`NougateMark.tsx` draws it";
    const refused = ["file-name: no tracked file is called `NougateMark.tsx`"];
    expect(rules(tree({ "internals/nougate/apps/frontend/NougateMark.tsx": "" }), named)).toEqual(refused);
    expect(rules(tree({}, ["internals/nougate/"]), named)).toEqual(refused);
    expect(rules(tree({}, ["internals/nougate/"]), "`internals/nougate/apps/frontend/NougateMark.tsx`")).toEqual([]);
  });

  test("a library named like a file is not one", () => {
    expect(rules(TREE, "the mistake `discord.js` made")).toEqual([]);
  });
});

describe("file:symbol and line numbers", () => {
  test("a symbol the file has passes; one it does not is named", () => {
    expect(rules(TREE, "`turns.store.ts:inserted`")).toEqual([]);
    expect(rules(TREE, "`turns.store.ts:recordStep`")).toEqual(["file-symbol: `turns.store.ts` has no `recordStep`"]);
  });

  test("a line number is refused, wherever it points", () => {
    expect(rules(TREE, "see core.ts:52")).toEqual(["line-number: `core.ts:52` — name the function or the section instead; lines move"]);
  });

  test("a line and column is a tool's output quoted, not a pointer", () => {
    expect(rules(TREE, "   core.ts:495:11  in validate")).toEqual([]);
    expect(rules(TREE, "see core.ts:52, then core.ts:60:3")).toEqual(["line-number: `core.ts:52` — name the function or the section instead; lines move"]);
  });
});

describe("sections", () => {
  test("a section the doc has passes, in either order", () => {
    expect(rules(TREE, "SPEC §6.3, and §6 of docs/SPEC.md")).toEqual([]);
  });

  test("one it does not have is named", () => {
    expect(rules(TREE, "ARCHITECTURE §205 and SPEC §9")).toEqual(["section: docs/SPEC.md has no §9"]);
  });
});

describe("commands", () => {
  test("a verb the CLI dispatches passes; one it does not is named", () => {
    expect(rules(TREE, "run `nouride status`, then `nouride activity`")).toEqual(["command: `nouride activity` is not a command the CLI dispatches"]);
  });
});

describe("links", () => {
  const links = (markdown: string, from = "docs/README.md"): string[] => linkProblems(TREE, markdown, from).map((f) => `${f.rule}: ${f.detail}`);

  test("a relative link resolves from the file it is in", () => {
    expect(links("[spec](./SPEC.md) and [core](../scripts/build/core.ts)")).toEqual([]);
    expect(links("[gone](./WHATSAPP.md)")).toEqual(["link: `./WHATSAPP.md` — no such file"]);
  });

  test("an anchor is a heading of the target, slugged as GitHub does", () => {
    expect(links("[prompt](./SPEC.md#63-system-prompt-builder) [chat](./CLI.md#nouride-chat)")).toEqual([]);
    expect(links("[x](./SPEC.md#7-gateways)")).toEqual(["anchor: `./SPEC.md#7-gateways` — docs/SPEC.md has no such heading"]);
  });

  test("a heading inside a code block is not one, and a link inside one is not checked", () => {
    expect(links("[x](./CLI.md#not-a-heading)")).toHaveLength(1);
    expect(links("```\n[x](./GONE.md)\n```\n")).toEqual([]);
  });

  test("slugs", () => {
    expect(slug("6.3 System Prompt Builder")).toBe("63-system-prompt-builder");
    expect(slug("`nouride chat`")).toBe("nouride-chat");
    expect(slug("TD-014: Five packages, not four")).toBe("td-014-five-packages-not-four");
  });
});

describe("links into the site's docs", () => {
  const INSTALL = [
    "---",
    "title: Install",
    "---",
    "",
    "## Downloading the binary",
    "",
    "<Steps>",
    "1. ### Find the first-time password",
    "",
    "   ```bash",
    "   # As the service account",
    "   ```",
    "",
    "    #### Raspberry Pi and Orange Pi",
    "</Steps>",
    "",
    "## Next",
    "",
    "## Next",
    "",
  ].join("\n");
  const SITE = tree({
    "apps/site/src/content/docs/en/docs/start/install.mdx": INSTALL,
    "apps/site/src/content/docs/id/docs/reference/config.md": "# Konfigurasi\n\n## `[external_clis]`\n",
    "apps/site/src/content/docs/en/docs/manual/index.md": "# Manual\n",
  });
  const links = (markdown: string, from = "apps/site/src/content/docs/en/docs/start/troubleshooting.md"): string[] =>
    linkProblems(SITE, markdown, from).map((f) => `${f.rule}: ${f.detail}`);

  test("a link names a page the site has, .md or .mdx or a folder's index, with its slash or without; one it does not have is named", () => {
    expect(links("[a](/en/docs/start/install/) [b](/en/docs/start/install) [c](/id/docs/reference/config/) [d](/en/docs/manual/)")).toEqual([]);
    expect(links("[gone](/en/docs/start/installing/)")).toEqual([
      "link: `/en/docs/start/installing/` — the site has no such page (apps/site/src/content/docs/en/docs/start/installing)",
    ]);
    // Each language is its own tree: the Indonesian page is not the English one.
    expect(links("[x](/id/docs/start/install/)")).toHaveLength(1);
  });

  test("its anchor is a heading of the page as the site renders it: in a list item, indented, or code-quoted", () => {
    expect(links("[a](/en/docs/start/install/#find-the-first-time-password) [b](/en/docs/start/install/#raspberry-pi-and-orange-pi)")).toEqual([]);
    expect(links("[c](/id/docs/reference/config/#external_clis) [d](/en/docs/start/install/#_top)")).toEqual([]);
    expect(links("[x](/en/docs/start/install/#find-the-password)")).toEqual([
      "anchor: `/en/docs/start/install/#find-the-password` — apps/site/src/content/docs/en/docs/start/install.mdx has no such heading",
    ]);
  });

  test("a repeated heading is numbered as the site numbers it, and a line in a fenced block is no heading", () => {
    expect(siteAnchors(INSTALL)).toEqual(new Set(["_top", "downloading-the-binary", "find-the-first-time-password", "raspberry-pi-and-orange-pi", "next", "next-1"]));
    expect(links("[x](/en/docs/start/install/#as-the-service-account)")).toHaveLength(1);
  });

  test("the whole address and a component's href are read too; another site, and a link in code, are not", () => {
    expect(links("[a](https://nouride.com/en/docs/start/install/#next-1)\n<LinkCard title=\"x\" href=\"/en/docs/start/install/\" />")).toEqual([]);
    expect(links("[a](https://nouride.com/en/docs/start/gone/)\n<LinkCard href=\"/en/docs/start/gone/\" />")).toEqual([
      "link: `/en/docs/start/gone/` — the site has no such page (apps/site/src/content/docs/en/docs/start/gone)",
      "link: `https://nouride.com/en/docs/start/gone/` — the site has no such page (apps/site/src/content/docs/en/docs/start/gone)",
    ]);
    expect(links("[a](https://example.com/en/docs/gone/) `[b](/en/docs/gone/)`\n```\n[c](/en/docs/gone/)\n```\n")).toEqual([]);
  });
});

describe("stacked doc blocks", () => {
  const lines = (source: string): number[] => stackedDocBlocks("x.ts", source);

  test("a file header over the first declaration's doc is two docs, each on something", () => {
    expect(lines("/** The file. */\n\n/** The function. */\nexport function f() {}\n")).toEqual([]);
    expect(lines('import { x } from "y";\n/** The file, after its imports. */\n\n/** The const. */\nconst a = x;\n')).toEqual([]);
  });

  test("a doc on a doc describes nothing, and so does one on the end of the file", () => {
    expect(lines("/** Header. */\nconst a = 1;\n/** Orphan. */\n\n/** Real. */\nconst b = 2;\n")).toEqual([3]);
    expect(lines("/** Header. */\nconst a = 1;\n/** Nothing below. */\n")).toEqual([3]);
  });

  test("at any depth, and only between two doc blocks", () => {
    expect(lines("/** H. */\nconst o = {\n  /** Orphan. */\n  /** Real. */\n  a: 1,\n};\n")).toEqual([3]);
    expect(lines("/** H. */\nconst a = 1;\n/** Doc. */\n// a note\n/** Doc. */\nconst b = 2;\n")).toEqual([]);
  });

  test("a string that holds `/**` is not a comment", () => {
    expect(lines('/** H. */\nconst a = "/** not a doc */";\n/** Real. */\nconst b = 2;\n')).toEqual([]);
  });
});

describe("a clone without the private submodules", () => {
  test("a pointer into a private path is not judged where the tree has none of it", () => {
    // A tree with no `internals/` at all, not even as a submodule's entry: 123 pointers into it were findings in the
    // first public export (2026-11-06), every one correct where the submodules are checked out.
    const root = mkdtempSync(join(tmpdir(), "nr-export-"));
    try {
      const git = (...args: string[]) => spawnSync("git", args, { cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) });
      git("init", "-q");
      spawnSync("mkdir", ["-p", join(root, "apps/cli/src")]);
      writeFileSync(join(root, "apps/cli/src/run.ts"), "");
      writeFileSync(join(root, "README.md"), "see `internals/pro/docs/x.md`\n");
      git("add", "-A");
      const index = buildIndex(root);
      expect(index.absent).toEqual(expect.arrayContaining(["internals/"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Nouride Home, a related repository", () => {
  test("its path is absent here, with a clone of it or without: none of its files are this tree's, and a pointer into it is not judged", () => {
    // A submodule from 2026-11-07 to 2026-11-08, then its own repository, linked from the README; a clone of
    // it beside Nouride is ignored, and a fresh clone of this one has none.
    for (const clone of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "nr-related-"));
      try {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
        const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, env });
        git(root, "init", "-q");
        spawnSync("mkdir", ["-p", join(root, "apps/cli/src")]);
        writeFileSync(join(root, "apps/cli/src/run.ts"), "");
        writeFileSync(join(root, ".gitignore"), "/apps/android-appliance/\n");
        if (clone) {
          spawnSync("mkdir", ["-p", join(root, "apps/android-appliance/scripts")]);
          git(join(root, "apps/android-appliance"), "init", "-q");
          writeFileSync(join(root, "apps/android-appliance/scripts/build-rootfs.sh"), "# pinned in its own assets.lock\n");
        }
        git(root, "add", "-A");
        const index = buildIndex(root);
        expect({ clone, absent: index.absent.includes("apps/android-appliance/") }).toEqual({ clone, absent: true });
        expect([...index.files].filter((rel) => rel.startsWith("apps/android-appliance"))).toEqual([]);
        expect(rules(index, "see `apps/android-appliance/README.md`")).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe("another product in a submodule", () => {
  test("a submodule that is not checked out is absent, not a file, so a pointer into it is not judged", () => {
    // Pro's own CI checks out Pro and Nougate and nothing else a docs page may point into.
    const root = mkdtempSync(join(tmpdir(), "nr-gitlink-"));
    try {
      const git = (...args: string[]) => spawnSync("git", args, { cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) });
      git("init", "-q");
      spawnSync("mkdir", ["-p", join(root, "apps/cli/src")]);
      writeFileSync(join(root, "apps/cli/src/run.ts"), "");
      git("add", "-A");
      git("update-index", "--add", "--cacheinfo", "160000,0123456789012345678901234567890123456789,apps/other-product");
      const index = buildIndex(root);
      expect(index.absent).toContain("apps/other-product/");
      expect(index.files.has("apps/other-product")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the real tree", () => {
  test.skipIf(!existsSync(join(ROOT, "internals/pro/.git")))("a commit hook's git variables do not hide a submodule's files", () => {
    // A hook runs with `GIT_INDEX_FILE` naming the superproject's index; the lint ran clean by hand and failed in the
    // hook on every pointer into `internals/`.
    const run = spawnSync(process.execPath, ["scripts/check-pointers.ts"], {
      cwd: ROOT,
      env: { ...process.env, GIT_INDEX_FILE: join(ROOT, ".git/index") },
    });
    // Each pointer into `internals/` was a finding there. The success line may still name a submodule that is not
    // checked out — `(not checked out, so not judged: internals/nougate/)` — which is not one.
    expect(run.stdout.toString() + run.stderr.toString()).not.toContain("lead nowhere");
    expect(run.status).toBe(0);
    // A whole lint run in a process of its own: about two seconds alone, and past five under a loaded machine.
  }, 60_000);

  test("every pointer leads somewhere, and enough of them were read to mean it", () => {
    const { findings, pointers } = check(buildIndex());
    expect(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.detail}`)).toEqual([]);
    expect(pointers).toBeGreaterThan(500);
    // Parses every source file in the tree: two seconds on a laptop, several on a loaded runner.
  }, 30_000);
});
