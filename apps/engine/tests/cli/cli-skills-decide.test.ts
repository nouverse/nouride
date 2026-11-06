/**
 * `nouride skills drafts` and `approve` say what a draft moves (0.7.27).
 *
 * On the first live run of the weekly review, approving an archive printed "formula-renderer is in the pool — on for
 * every agent", and the list called an archive and a merge "improves". A new skill is on for one agent now, too.
 */

import { expect, spyOn, test } from "bun:test";
import type { Client } from "@/cli/client.ts";
import { skills } from "@/cli/commands/skills.ts";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const draft = (id: string, name: string, extra: { target?: string; retire?: string[]; triggerKind?: string } = {}) => ({
  id,
  name,
  agentId: "nouva",
  createdAt: Date.UTC(2026, 9, 22, 19, 5),
  description: `Use when ${name} is needed.`,
  triggerKind: extra.triggerKind ?? "curation",
  triggerReason: "the weekly review",
  requires: "",
  needsTools: "",
  body: "",
  target: extra.target ?? null,
  files: [],
  removeFiles: [],
  carries: [],
  retire: extra.retire ?? [],
});

const PENDING = [
  draft("dft_archive", "formula-renderer", { target: "formula-renderer", retire: ["formula-renderer"] }),
  draft("dft_merge", "deployment", { target: "deployment", retire: ["deployment-docker", "deployment-k8s"] }),
  draft("dft_tighten", "domain-management", { target: "domain-management" }),
  draft("dft_new", "release-notes", { triggerKind: "sustained" }),
];

async function run(args: string[]): Promise<string> {
  const client = {
    get: async <T>() => ({ enabled: true, pending: PENDING, recent: [] }) as T,
    post: async <T>(path: string) => ({ ok: true, skill: path.split("/")[3], path: path.includes("archive") ? "" : "/pool/SKILL.md" }) as T,
  } as unknown as Client;
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(plain(String(line ?? ""))));
  try {
    await skills(client, args);
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

test("the list names what approving moves: an archive, a merge, an improvement", async () => {
  const out = await run(["drafts"]);
  expect(out).toContain("archives formula-renderer");
  expect(out).toContain("merges deployment-docker, deployment-k8s into deployment");
  expect(out).toContain("improves domain-management");
  expect(out).not.toContain("improves formula-renderer");
});

test("approving an archive says it left the pool", async () => {
  const out = await run(["approve", "dft_archive"]);
  expect(out).toContain("formula-renderer archived, and out of every prompt from the next message");
  expect(out).not.toContain("is in the pool");
});

test("approving a merge names what it archived", async () => {
  expect(await run(["approve", "dft_merge"])).toContain("deployment updated: whoever has it reads the new version from the next message; deployment-docker, deployment-k8s archived");
});

test("approving a new skill says it is on for the agent that learned it, not for every agent", async () => {
  const out = await run(["approve", "dft_new"]);
  expect(out).toContain("release-notes is in the pool, on for nouva from the next message");
  expect(out).not.toContain("every agent");
});
