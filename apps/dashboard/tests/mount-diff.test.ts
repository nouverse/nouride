/**
 * Every diff drawn one way (0.8.8, `DiffView`): a skill's pending draft against the skill on disk, and an approval's edit.
 * A screenshot of the Workshop: the draft's lines ran past the box that tinted them, cut on the left and the
 * colour stopping halfway. In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });

const before = Array.from({ length: 20 }, (_, i) => `Step ${i + 1}: something the skill already says.`);
const longLine = `Probe with python3 -c "import socket,time; [time.sleep(1) for _ in range(30) if socket.socket().connect_ex(('<host-ip>', 22)) == 0 or time.sleep(1)]" — never ping, ICMP raw sockets are refused in container sandboxes.`;
const after = [...before.slice(0, 10), longLine, ...before.slice(10)];

const draft = {
  id: "dft_1",
  createdAt: 1,
  agentId: "nouva",
  gatewayId: null,
  chatId: null,
  triggerKind: "error_recovery",
  triggerReason: "ping failed in the sandbox",
  name: "wake-pc",
  description: "Wake the PC",
  requires: "",
  body: after.join("\n"),
  target: "wake-pc",
  files: [],
  carries: [],
  model: null,
  status: "pending",
  decidedAt: null,
  decidedBy: null,
  publishedPath: null,
};

test("a skill draft's changes: each line wrapped beside its sign, tinted whole, the unchanged runs folded", async () => {
  answer({
    "/skills/drafts": ok({ enabled: true, pending: [draft], recent: [] }),
    "/skills/drafts/dft_1": ok({ ...draft, transcript: null }),
    "/skills/wake-pc/source": ok({ name: "wake-pc", description: "Wake the PC", scope: "shared", path: "/srv/skills/wake-pc/SKILL.md", requires: [], missing: [], source: `---\nname: wake-pc\n---\n${before.join("\n")}` }),
  });
  let added: Element | undefined;
  let folds: string[] = [];
  let summary = "";
  await renderPage("/skills", async (host) => {
    const pending = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.includes("Pending")) as HTMLElement;
    pending.click();
    await eventually(() => host.querySelector('button[aria-label="Review wake-pc"]') !== null, 2_000, "the draft");
    (host.querySelector('button[aria-label="Review wake-pc"]') as HTMLElement).click();
    await eventually(() => host.textContent?.includes("unchanged lines") === true, 2_000, "the diff");
    added = [...host.querySelectorAll(".bg-success\\/12")].find((row) => row.textContent?.includes("never ping"));
    folds = [...host.querySelectorAll("button")].map((button) => button.textContent ?? "").filter((text) => text.includes("unchanged line"));
    summary = [...host.querySelectorAll("summary")].find((s) => s.textContent?.includes("Changes to"))?.textContent ?? "";
  });
  // The added line is one row: its sign in a column of its own, its whole text wrapped beside it — never cut, never scrolled.
  expect(added).toBeDefined();
  expect(added!.className).toContain("grid-cols-[1.75rem_minmax(0,1fr)]");
  expect(added!.querySelector(".whitespace-pre-wrap")?.textContent).toContain(longLine);
  // Seven unchanged lines before the change and seven after, three of each kept beside it.
  expect(folds).toEqual(["7 unchanged lines", "7 unchanged lines"]);
  expect(summary).toContain("+1 −0");
});

test("an approval's edit is drawn by the same DiffView", async () => {
  const request = {
    id: "apr_1",
    agentId: "nouva",
    chatId: "8142",
    tool: "persona",
    params: {},
    grantable: false,
    preview: { kind: "edit", path: "SOUL.md", added: 1, removed: 1, hunk: [{ sign: "-", text: "Ask before a push." }, { sign: "+", text: "Ask before a push or a force-push." }], clipped: false },
    requestedAt: 1,
    timeoutMs: 86_400_000,
  };
  answer({ "/approvals": ok({ pending: [request] }) });
  let removed: Element | undefined;
  // Overview lists every pending approval (`mount-approval-queued.test.ts`).
  await renderPage("/", async (host) => {
    await eventually(() => host.textContent?.includes("SOUL.md") === true, 2_000, "the approval");
    removed = [...host.querySelectorAll(".bg-error\\/12")].find((row) => row.textContent?.includes("Ask before a push."));
  });
  expect(removed).toBeDefined();
  expect(removed!.className).toContain("grid-cols-[1.75rem_minmax(0,1fr)]");
});

test("a persona change's kept lines are all drawn in its approval — none folded behind a press", async () => {
  // What a reworded rule now covers (0.8.13): the admin decides on it, so it is never three lines and a fold.
  const kept = Array.from({ length: 8 }, (_, i) => `  and the rule goes on past its first line, line ${i + 1}`);
  const request = {
    id: "apr_2",
    agentId: "nouva",
    chatId: "8142",
    tool: "persona",
    params: {},
    grantable: false,
    preview: {
      kind: "edit",
      path: "SOUL.md",
      added: 1,
      removed: 1,
      hunk: [{ sign: "-", text: "[# SOUL] - Ask before deleting" }, { sign: "+", text: "[# SOUL] - Free to delete" }, ...kept.map((text) => ({ sign: " ", text }))],
      clipped: false,
    },
    requestedAt: 1,
    timeoutMs: 86_400_000,
  };
  answer({ "/approvals": ok({ pending: [request] }) });
  let folds: string[] = [];
  let drawn = "";
  await renderPage("/", async (host) => {
    await eventually(() => host.textContent?.includes("Free to delete") === true, 2_000, "the approval");
    folds = [...host.querySelectorAll("button")].map((button) => button.textContent ?? "").filter((text) => text.includes("unchanged line"));
    drawn = host.textContent ?? "";
  });
  expect(folds).toEqual([]);
  for (const line of kept) expect(drawn).toContain(line.trim());
});
