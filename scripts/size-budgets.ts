/**
 * The size check's tables (`check-size.ts`): the files over a cap, each with the size it may reach and why it stays
 * whole, and the `any` the test suite still holds. Apart from the check because the tables are what changes most.
 */

/**
 * A file's budget: the size it may reach, and why it stays whole.
 *
 * The number and its reason are one entry, so they change together. The reason is today's, in at most `MAX_WHY`
 * characters: when each raise added a clause, the reasons became a changelog nobody read, and a raise went in with
 * nothing to weigh it against. What the file was is in git.
 *
 * The ratchet turns both ways. A file may not grow past its budget; a budget more than `HEADROOM` above its file is
 * slack that would let the file grow back unseen, and is reported until it is lowered; a file back under the cap
 * loses its entry. Raising a budget is allowed, with `why` rewritten to say what the lines are and why they belong in
 * this file. Contorting code to fit a number is not the point of the number.
 */
export interface Budget {
  lines: number;
  why: string;
}

/** Source files over `MAX_CODE_LINES`. */
export const BUDGET: Record<string, Budget> = {
  "packages/policy/src/hardline.ts": {
    lines: 553,
    why: "a security classifier: what an agent may never do without a human, and the credential paths read word by word. It grows by a rule; a second way of classifying goes in a file of its own",
  },
  "apps/engine/src/modules/config/schema.docs.ts": {
    lines: 475,
    why: "one annotation per setting, the list `config explain` and the dashboard read; it grows by an entry, or a rule an entry must say, and splitting it would hide the list it is",
  },
  "apps/engine/src/modules/web/control/routes/chat.ts": {
    lines: 505,
    why: "the dashboard chat's routes together: upload, send, live, transcripts, files, delete, each answer held to the wire's type and to whose the conversation is (`whose.ts`)",
  },
  "apps/engine/src/modules/external-agents/index.ts": {
    lines: 531,
    why: "the service the agents' CLIs run under: their connections, sessions, sign-ins, models and lent tools, as the runner reaches them through `RunnerHost`; each one's logic is in a file beside it",
  },
  "apps/engine/src/modules/cron/cron.store.ts": {
    lines: 463,
    why: "the job table and the one place `next_run_at` moves, so no schedule is advanced twice; validation is `cron/validate.ts`, turning a proposal on is `cron/proposals.ts`",
  },
  "packages/persona/src/config.ts": {
    lines: 492,
    why: "a pack's `config.toml` mapped field by field, so each refusal names its file and field: one list, the pack's schema. Its MCP server readers are the seam if it grows by more than a field",
  },
  "apps/engine/src/modules/jobs/jobs.store.ts": {
    lines: 511,
    why: "the background job table: a command's, a helper's and a background ask's rows, every write to `jobs.status` in one class; the wake-up text and a helper's runtime half are beside it",
  },
  "apps/engine/src/modules/tools/registry.ts": {
    lines: 450,
    why: "the built-in tools and one agent's toolset made of them: what it is offered, how each is gated and masked, and what its prompt is told it was resolved with, in the one place to read it",
  },
  "apps/engine/src/modules/tools/builtins/exec.ts": {
    lines: 426,
    why: "the exec tool's gate and run: each check a command passes before it starts, made in its order and rechecked in `execute` in the same order; the checks themselves live beside it",
  },
  "apps/engine/src/modules/tools/builtins/files.ts": {
    lines: 428,
    why: "the file tools (`read`, `write`, `edit`, `multi_edit`) with what each declares to the executor, and the one `resolve` every path goes through, so the path guards are read in one place",
  },
  "apps/engine/src/modules/tools/approvals.store.ts": {
    lines: 523,
    why: "the approval gate: one table and the requests in flight, asked, queued per chat, answered once and kept across a restart, over one set of maps every step reads and writes",
  },
  "apps/engine/src/modules/turns/turns.store.ts": {
    lines: 463,
    why: "the turn record and its columns, the causes it names, the clause every read of a conversation uses to leave a delegate's own turns out, and the queries that use it, a restart's two marks among them",
  },
  "apps/engine/src/modules/missions/missions.ts": {
    lines: 581,
    why: "the missions' one service (start, the dispatcher, a turn's shape and end, stop, continue, which hold a slot) over state this class alone holds; its pure rules are apart: `decide.ts`, `counts.ts`",
  },
  "packages/gateways/src/channels/discord/gateway.ts": {
    lines: 426,
    why: "one Discord connection: its client's events, sends in parts at the pace Discord allows, edits, files, buttons, presence and reconnect, each on the one client they share",
  },
  "apps/engine/src/modules/pipeline/attachments.ts": {
    lines: 409,
    why: "the one place a message's files become what the agent gets (stored, shown, described, heard or transcribed) and the note that says which, so the note and the parts cannot disagree",
  },
  "scripts/build/core.ts": {
    lines: 432,
    why: "the release build in the order a tarball is made: the edition this checkout can build, compile, check what is embedded, stage what goes beside the binary, pack, say what was built; staging is the seam",
  },
  "scripts/check-sql.ts": {
    lines: 495,
    why: "the SQL lint: one reader of the code's SQL and three judges of it (text rules, plans, floors), and the list of constant clauses it lets through; the plan half is the seam when it grows",
  },
  "packages/gateways/src/channels/whatsapp/gateway.ts": {
    lines: 417,
    why: "the WhatsApp adapter's one state machine (bridge reachable, number linked, sends held) that every bridge event's handler reads and writes; moving the link state out would split it in two",
  },
};

/** Test files over `MAX_TEST_CODE_LINES`; new cases go in a file of their own. */
export const TEST_BUDGET: Record<string, Budget> = {
  "apps/engine/tests/pipeline/pipeline.test.ts": {
    lines: 3_828,
    why: "the pipeline's first suite, from before the pipeline was split, its cases on the one `harness` this file builds; new cases go beside the module they test",
  },
  "apps/engine/tests/persona/reflection.test.ts": {
    lines: 2_075,
    why: "reflection end to end, written before `modules/reflection` was split, on this file's `enginePointedAt` harness; new cases go to tests/reflection/",
  },
  "apps/dashboard/tests/mount.test.ts": {
    lines: 1_576,
    why: "every dashboard page mounted, and the cases that click through one; the harness is `mount-harness.ts`, so a page's new cases go in a file of their own",
  },
  "apps/engine/tests/llm/prompt.test.ts": {
    lines: 1_041,
    why: "prompt assembly: every section and its order, and the words that carry each rule; new cases go in a file of their own",
  },
};

/**
 * `any` still present in the test suite, per file, at the count when this rule landed.
 *
 * The rule is not exempt for tests and should not be — a fake typed `any` cannot disagree with the
 * thing it stands in for, which is how a test starts agreeing with the bug. That is not theoretical
 * here: `PendingApproval` was narrowed to `{ id: string }`, its fixtures matched, and the CLI printed
 * `undefined` for four fields nobody's test could see.
 *
 * Ratcheted rather than fixed in the same commit as the rule, because 49 sites in seven files is a
 * separate piece of work and a rule that waits for it is a rule that does not land. Each of these may
 * go down and none may go up.
 */
export const ANY_BUDGET: Record<string, number> = {
  "apps/engine/tests/pipeline/pipeline.test.ts": 16,
  "apps/engine/tests/config/config-edit.test.ts": 14,
  "packages/runtime/tests/toml.test.ts": 6,
  "apps/engine/tests/daemon/setup.test.ts": 4,
  "apps/engine/tests/config/config-schema.test.ts": 3,
  "apps/engine/tests/tools/search-backends.test.ts": 2,
  "apps/engine/tests/helpers.ts": 2,
};
