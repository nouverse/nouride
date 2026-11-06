/**
 * A yes says which request it answered, and that request's preview is read back from the database (0.8.13): what a tool
 * whose write depends on what was approved checks — the persona tool's digest of the file its diff was made from. Kept
 * in memory before, it was gone after a restart and stale after a denial.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import { SqliteApprovalGate, type ApprovalNotice } from "@/modules/tools/approvals.store.ts";
import { eventually, tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;

beforeEach(async () => {
  dir = tempDir("nouride-answered-");
  db = await openAndMigrate(join(dir, "test.db"));
});
afterEach(() => {
  db.close();
  removePath(dir);
});

const ask = (): ApprovalAsk =>
  ({
    agentId: "nix",
    chatId: "555",
    gateway: "telegram",
    gatewayId: "telegram:nix",
    senderId: "555",
    tool: "persona",
    params: { file: "AGENTS.md", content: "# Agents\n", reason: "Tidy." },
    grantable: false,
    autoCoverable: false,
    hardlineClass: "persona",
    reason: "nix asks to change its own AGENTS.md",
    preview: { kind: "edit", path: "AGENTS.md", added: 1, removed: 0, hunk: [{ sign: "+", text: "# Agents" }], clipped: false, against: "a".repeat(64) },
  }) as unknown as ApprovalAsk;

test("an approved outcome names its request, and that request's preview is read back — by a gate made after it too", async () => {
  const gate = new SqliteApprovalGate({ db, timeoutMs: 60_000, onRequest: () => {} });
  const outcome = gate.request(ask());
  await eventually(() => gate.pending().length === 1, 2_000, "the question");
  const id = gate.pending()[0]!.id;
  gate.resolve(id, "allow-once", "gading");
  expect(await outcome).toMatchObject({ status: "approved", id, by: "gading" });
  // As after a restart: another gate over the same database.
  const later = new SqliteApprovalGate({ db, timeoutMs: 60_000, onRequest: () => {} });
  expect(later.previewOf(id)).toMatchObject({ kind: "edit", against: "a".repeat(64) });
  expect(later.previewOf("apr_nothing")).toBeNull();
  gate.shutDown();
  later.shutDown();
});

test("the question put in front of a chat carries the request's preview — the diff an admin answers there (0.8.13)", async () => {
  // Stored with the row and left out of the notice, a chat's question showed the arguments as JSON: a persona's diff was
  // seen there only once a restart had read the question back from the database.
  const notices: ApprovalNotice[] = [];
  const gate = new SqliteApprovalGate({ db, timeoutMs: 60_000, onRequest: (notice) => notices.push(notice) });
  void gate.request(ask());
  await eventually(() => notices.length === 1, 2_000, "the question");
  expect(notices[0]!.request.preview).toMatchObject({ kind: "edit", path: "AGENTS.md", hunk: [{ sign: "+", text: "# Agents" }] });
  gate.shutDown();
});
