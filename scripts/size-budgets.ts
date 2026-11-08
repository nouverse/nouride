/**
 * The size check's tables (`check-size.ts`): the files over a cap, each with the size it may reach and why it stays
 * whole, and the `any` the test suite still holds. Apart from the check because the tables are what grows — each budget
 * a number and a reason that gains a clause when the number moves — and the check had grown past its own cap with them.
 */

/**
 * A file's budget: the size it may reach, and why it stays whole.
 *
 * The number and its reason are one entry, so they change together: when they were a number with a running changelog
 * of `+3: …` comments beside it, the comments stopped matching the numbers (a "762" docblock sat on a budget of 758).
 *
 * The ratchet turns both ways. A file may not grow past its budget; a budget more than `HEADROOM` above its file is
 * slack that would let the file grow back unseen, and is reported until it is lowered; a file back under the cap
 * loses its entry. Raising a budget is allowed — with a reason in `why` that says what the lines are and why they
 * belong in this file. Contorting code to fit a number is not the point of the number.
 */
export interface Budget {
  lines: number;
  why: string;
}

/** Source files over `MAX_CODE_LINES`. */
export const BUDGET: Record<string, Budget> = {
  "packages/policy/src/hardline.ts": {
    lines: 551,
    why:
      "a security classifier: the list of what an agent may never do without a human. It grows by a rule and for " +
      "nothing else — a helper or a second way of classifying goes in a file of its own. Rewriting working refusal " +
      "rules for elegance is how a hole gets in; 507 → 513 for `unwatched` on the summary: work nobody watches sending where its job did not name, or what the second look held (0.8.0); 513 → 519: `shared-tools` (0.8.1), a program installed for every agent as the daemon's user — asked under trusted too, on the list a person reads; 519 → 525 (0.8.8): the `persona` class in `BALANCED_ASKS` and its row in `HARDLINE_SUMMARY`; 525 → 531 (0.8.9, N5): the `people` class, the same two places; 531 → 545 (0.8.13, C7): an agent's persona files in the own-state table as the `persona` class, and each path in a command read from its folder — `pathsIn` and `resolvedFrom` beside the table they serve; 545 → 551 (0.8.15): the `system-packages` class back on the list — `nouride pkg install|remove|upgrade`, as root — in `BALANCED_ASKS` and its row in `HARDLINE_SUMMARY`",
  },
  "apps/engine/src/modules/config/schema.docs.ts": {
    lines: 472,
    why:
      "one annotation per setting, the list `config explain` and the dashboard read; it grows by an entry when the config gains a key — " +
      "469 → 472 for `[daemon] backup_seal`, what it keeps and that only `nouride secret seal` writes it (0.8.18); " +
      "466 → 469 for `[update] track`, latest or lts, with how a Pro install or a Box takes it (0.8.18); " +
      "464 → 465 for `[llm.defaults] fallbacks` naming what counts as a provider down, the stream that fails mid-reply and the closing call (0.8.1); " +
      "454 → 457 for `[missions] max_running` following the agents unset (0.8.0, merged forward), with how high it may be set; " +
      "447 → 454 for `[llm.defaults] fallbacks` (0.8.0), one entry; " +
      "455 → 460 for `[memory] recall` (0.7.27), with what it leaves out and that a person's own wins, then 460 → 434 when `[rsi]`'s eight keys became `[skills.learning]`'s three (0.7.27); " +
      "449 → 455 for `[llm.defaults] effort` (0.7.26), with what each wire calls it and what unset costs; " +
      "447 → 449 for 0.7.25's `[agents] nudge_after_minutes`, with the caveat that nothing is stopped; " +
      "0.7.12's `[memory] pass_max_tokens`, and `pass_per_night`'s caveat on where falling behind is shown; 0.7.15's " +
      "`[delegate] max_background`, with the caveat that helpers hold no chat's slot; 0.7.18's `[daemon] orchestrator_mode`, " +
      "with the caveat that boot refuses it without an enabled `default_agent`; 434 → 441 for `[security.exec] landlock` (0.8.0): what it confines, its three values, and that it does nothing without the helper; " +
      "419 → 447 for `[missions]`'s five keys (0.8.0), with the caveats that a mission waiting for a person holds no slot and takes its limits when it starts; 457 → 464 for `[security] model_guard`, the second look (0.8.0): its three shapes, what it is not, and why empty is not off; 465 → 466 for `[missions] per_agent` saying an agent's own is used in its place, and that two missions in one repository take turns whatever it is (0.8.11)",
  },
  "apps/engine/src/modules/web/control/routes/chat.ts": { lines: 487, why: "the chat routes; what a session id names moved to `web/control/conversation.ts`; 476 → 478 for a mission's own conversation deleted taking its mission with it (0.8.0) — the delete route is this file's, and left alone the mission worked on with its checklist gone; 478 → 480: a token caller refused the daemon's own sender, which its events pass the allowlist and rate limit with (0.8.1) — `send`'s, so this file's; 480 → 485 for a conversation whose first turn is still running, which has no row yet: its transcript names the session that turn is for, so the page shows its agent rather than the orchestrator (2026-11-02, Nix opened from the Office); 485 → 487: the page's own words beside the CLI's on two refused sends (0.8.20, `plain`), the dashboard's chat turned off and no agent named, each beside the reply it is for" },
  "apps/engine/src/modules/external-agents/index.ts": { lines: 527, why: "the service the agents' CLIs run under: their connections, sessions, sign-ins, models and lent tools, as the runner reaches them through `RunnerHost`; 400 → 402 for what each CLI session was last told of who is here (0.8.5), held where its sessions are — the telling is `situation.ts`; 433 → 436 for the efforts each CLI offers for its model (0.8.7), kept beside the models it offers; 436 → 441 for what an agent's CLI takes in a prompt (0.8.7), asked of its running connection before the turn prompts — reading it is `prompt.ts`; 441 → 452 for what answers a CLI agent, as `/status` asks it (0.8.8): its running connection's handshake, the model it opened on and the context each session last said, held where the connections and sessions are — the reading is `usage.ts`; 452 → 456 for whether nothing asks before the agent deletes (0.8.8): its preset, which this service decides, read for a mission's page; 456 → 468 for what each session opened on (0.8.8): kept with the session, read by the runner, forgotten with it and by `renew` on `agent reload` — the record is `instructed.ts`, the comparison `runner.ts`; 468 → 472 for whether a session still owes its chat what it said by itself or a command it left running (Nox's review), read from the two records this service holds before such a session is let go; 472 → 476 for what each conversation's running CLI turn has spent so far (0.8.8), held beside the contexts the same updates fill and read by a mission's token limit — the estimate is `usage.ts`'s `PromptSpend`; 476 → 480 for telling the missions a conversation's running CLI turn spent more (`onSpent`, 0.8.8), set once they exist, as `onOwnWords` is; 480 → 483 for auditing a shared account's sign-in that kept a token, with who started it (0.8.9, HARDENING §8), where the token is kept; 483 → 487 for the skills an agent's `skill_roots` bring (0.8.9), read at each copy of its skills and handed to `syncSkills` with its own — the merge is `skills.ts`; 487 → 495 for whether an agent's CLI takes a message mid-prompt (`steersMidPrompt`, 0.8.10), read off the connection this service holds, and the hold the runner reads (`steerHoldMs`) — the handing over is `steering.ts`; 495 → 505 (0.8.11): a CLI started again when the secrets it starts with changed, at a turn where nothing else of the agent is at work — a hash of them kept per running CLI and compared where `connection` already compares the CLI and the profile, beside which it belongs; 505 → 524 for `forTurn` (0.8.15): a turn waits for the CLI to be free to start again with changed secrets, or is told which its shell lacks — the method and its per-variable hashes need the running CLI and what it left running, which are this class's; the comparing and the wait are in `fresh-secrets.ts`; 524 → 527 for `offeredEfforts` (0.8.16), the levels `/effort` checks a chat's against, read off the efforts this service keeps" },
  "apps/engine/src/modules/cron/cron.store.ts": { lines: 510, why: "the job table and the one place `next_run_at` moves; validation lives in `cron/validate.ts`; 467 → 476 for 0.8.0's three new columns read off the row — a webhook's last reach test, a proposal, who turned it on — and the reach test's write; turning a proposal on lives in `cron/proposals.ts`; 476 → 482 for a proposal created off and its yes kept (`settleProposal`)" },
  "packages/persona/src/config.ts": {
    lines: 491,
    why:
      "a pack's `config.toml`, mapped field by field so each refusal names its file and its field — one list, the pack's " +
      "schema (479 → 468 in 0.8.0: `fallbacks`, and in 0.8.1 the refusal of the `fallback_model` it replaced, read in `fallbacks.ts`) — " +
      "schema, as `config/defaults.ts` is the daemon's; it grows by a field when a pack gains one (0.7.15's `[delegate] " +
      "max_background`, 0.7.17's `[security] secret_guard`). Its helpers (`mcpServers`, `execSecrets`, the readers) are the seam if it grows by more than a field; 406 → 421 for `env_secrets` (0.7.19): a stdio MCP server's credential variables, each refused here when it names no variable, repeats `env`, or holds the token itself; " +
      "421 → 431 for `auth = \"oauth\"` (0.7.19): a remote server's login mark, refused here on a stdio server and beside a credential of the server's own; 0.7.19 (431 → 432): `mcp_search` is one of the built-ins `*` means; " +
      "432 → 440 for the MCP library (0.7.19): the server reader exported for `agents/mcp.toml`, which takes the same blocks with " +
      "`per_agent` added and says its own block's name in a refusal, and the secret-name check shared with an agent's `mcp.toml`; " +
      "440 → 445 for `tools` (0.7.21): which of a server's tools the agent gets, one field of the block, its list reader shared with an agent's `mcp.toml`; " +
      "445 → 454 for 0.7.23's preset rename, read as the new name until 0.7.28 and refused in 0.8.0; " +
      "454 → 455 for `send_message` (0.7.23): one of the built-ins `*` means, and in the default set beside `send_file`; " +
      "455 → 465 for `[llm] effort` (0.7.26): a level refused at load with the five it may be, else the daemon's default; " +
      "465 → 460 in 0.8.0: the old forms' readers out — renamed tools, the `exec_secrets` list, a pack's own MCP servers, the " +
      "presets' old names — and a refusal naming today's form in each place; 460 → 464 for 0.8.0's `[security] credentials`, whether the agent's own user reads the credentials directory; 464 → 468: `[security] shared_tools`, whether the orchestrator installs what every agent runs; 468 → 479 for the model tiers (0.8.0): `[llm] small_model` and `high_model`, two fields of the pack's `[llm]` and the one reader that refuses either when it is empty or names a tier; 468 → 475 for `[security] model_guard` read and refused where it is none of off, a tier or a model id (0.8.0); 482 → 510 for *always for this job* (0.8.0): `allow` and `disallow` write the job's `allowed` column and audit it, and a run keeps what its guards held (`held`) — rows of this store's two tables; 475 → 479 for `[external]` (0.8.1): the raw key, the known CLIs, and the table's read — its checks in `external.ts`; 479 → 482 for `[look]` (0.8.1): the cat in Nouride Office, read in `look.ts` and spread in here as `[external]` is; 402 → 414 for what a CLI says by itself between turns (0.8.6): kept by session where the connections are made and their sessions forgotten, and a CLI still running a command it started left out of the idle sweep — the keeping is `own-words.ts`, the counting `commandsRunningUnder`; 414 → 433: what those CLIs leave running, reached where the connections are — the jobs a restart waits for, the prompt that left one, and the chats a stop cut one off in, told at the start — the bookkeeping is `left-running.ts`; 482 → 491 for `[missions] per_agent` (0.8.11): how many missions the agent may have working at once, read and refused by its file and field as `[delegate] max_background` is, absent following the daemon's",
  },
  "apps/engine/src/modules/jobs/jobs.store.ts": {
    lines: 511,
    why:
      "the background job table and its state — deadline, services, the one `exec` adapter; the wake-up text is " +
      "`jobs/wake-text.ts`. The check that settles a stopped job is a `contained` timer, since a throw out of it ended the daemon. " +
      "0.7.15: a helper `delegate` starts in the background is a row of the same table (057's kind, brief, report, turn and " +
      "person), so its columns, its three writes and the stop that reaches it are here with a command's — every write to " +
      "`jobs.status` in one class; the helper's runtime half (its turn's handle, its limit, its log) is `jobs/helper-jobs.ts`. " +
      "0.7.17: a job's log is masked of the credentials sent in its conversation too, handed in with the command; and a " +
      "command records the turn it was started in, as a helper does, so an asked agent's job reports to the agent that asked. " +
      "497 → 506 for an ask that moved to the background (0.7.19): a row of the same table, so its kind, the agent and task " +
      "its row keeps (`AskedWork`, read from the brief column by the row's kind), its start, and what the one limit counts " +
      "(`backgroundTurns`) are here with the helper's; its runtime half is the helper's, in `jobs/helper-jobs.ts`; 0.7.19 (506 → 507): how many of the agents' commands the kernel stopped for memory while a job ran, carried from its exit to its completion — what its exit code may not show; " +
      "0.7.25 (507 → 510): a job started by a command that prints credentials has its log go through the same swap to handles as the foreground output (`tools/credential-output.ts`) — the option, handed through the `exec` adapter and into the spawn; 510 → 511: a job's sandbox names whose user it runs as — its agent's, or the daemon's for its own CLI (0.8.0)",
  },
  "apps/engine/src/modules/tools/registry.ts": {
    lines: 440,
    why:
      "the built-in tools and one agent's toolset made of them — what it is offered, how each is gated, what each " +
      "result is masked of: one place to read what an agent can do. 0.7.17: `secret_save` comes with `exec`, and the " +
      "credentials sent in a conversation reach its commands and are masked out of every tool's result there — as are " +
      "the daemon's own (the store, the control token, the credentials directory), one more thing a result is masked of. " +
      "0.7.19 (406 → 410): `mcp_search`, offered when the daemon has the MCP registry's copy — an option and the line that offers it; " +
      "0.7.23 (410 → 414): `send_message`, offered where the daemon has gateways to send through, and brought by `send_file` — an option, the line that offers it, and the implied pair; " +
      "0.7.25 (414 → 419): the daemon's own credentials handed to `exec` and `session` too, so a printed credential file's value that is one keeps its mask rather than gaining a handle (`tools/credential-output.ts`); " +
      "0.7.26 (419 → 427): `notes`, offered by the daemon to every agent that holds a tool — an option, the line that builds it, and the daemon-resolved block beside `attachment_read`'s — and `plan` built with the store it keeps a plan in; " +
      "416 → 419 for `mission` (0.8.0), handed per turn as that turn holds it — `start` in a chat, the mission's own actions in a mission's; 419 → 422 for `schedule`, resolved by the daemon for a chat's turn as `mission` is (0.8.0); 422 → 431: `delegate` is handed the mission's helper worktree (`isolated`, 0.8.1) — the option and its pass-through; 431 → 433: `isolated` is taken off `delegate`'s schema outside such a mission, as `background` is where it is not allowed; 0.8.7 (433 → 436): `work`, offered by the daemon to every agent that holds a tool, beside `notes` and `mission` — an option and its daemon-resolved line; 436 → 439 (0.8.8): `persona` resolved by the daemon for every agent that holds a tool, as `schedule` is; 439 → 440 (0.8.11): `mcp_search`'s link through the one rule for dashboard links (`web/links.ts`) instead of a bare address — the option's type and its import",
  },
  "apps/engine/src/modules/tools/builtins/exec.ts": {
    lines: 426,
    why:
      "the exec tool: its gate and its run, each check a command passes before it starts made here in the order it is " +
      "made — its own CLI, its own install, the store and the control token (0.7.17), the handles it names, the secret " +
      "guard, the policy — and rechecked in `execute` in the same order. The checks themselves live beside it " +
      "(`exec-own-install.ts`, `credential-files.ts`, `held-secrets.ts`, `git-guard.ts`); the order is what stays; 0.7.19 (401 → 403): a command the kernel cut into for memory is a failure that says so — a pipeline's exit code is its last command's, and an agent read 0 as success; " +
      "0.7.25 (403 → 414): a command that prints credentials — a credential file here or over ssh, an environment — has its output's values swapped for handles before anything keeps it: found here in the same order as the rest, handed to the capture, the job and the result's last line; the swap itself is `tools/credential-output.ts`; " +
      "0.7.26 (414 → 416): handles in the stdin the `nouride` tool feeds a command checked and guarded with the command's own, at the gate and in the run — the replacing is `withHeldValues`; 0.8.0 (416 → 423): a command names its agent, so it runs as that agent's own user, with its own HOME and place to install (`ownHomeEnv`) — except the daemon's own CLI, run for the agent by the `nouride` tool; 423 → 424: Rust's shared toolchains named for a command run as its agent's own user (`RUSTUP_HOME`) 0.8.7 (424 → 425): a mission's check is handed none of the secrets bound to its program, at the gate and in the run (`ToolContext.checkOnly`, `withoutBound`) — handed one, every `git` check of an agent with a token bound to `git` asked a person nobody was there to be; 425 → 426 for an asked agent's commands (0.8.8): none moved to the background by itself, and where a job it starts reports, said where the job starts — the words are `exec-started.ts`",
  },
  "apps/engine/src/modules/tools/builtins/files.ts": {
    lines: 425,
    why:
      "the file tools — `read` with its batch, `write`, `edit`, `multi_edit` — and the one `resolve` every path goes through, so the root and " +
      "path guards are read in one place; the pieces that read on their own are beside it (`edit-list.ts`, `edit-diagnostics.ts`, `read-image.ts`, " +
      "`document-kind.ts`). 0.7.25 (400 → 401): `write`'s `append`, a large file in parts — behind the same `resolve` and lock as the write it extends; 0.8.0 (401 → 402): every write goes through `writeAgentFile`, which writes an agent's own folders as that agent; 402 → 416: a write to a `config.toml` that decides what agents may do is on the fixed list (`writesConfig`) — through the same `resolve`, where the path is the tool's own to read; 416 → 420: `~/` is the HOME the agent's commands have (`expandAgentHome`), which `resolve` and the search tools share; 420 → 424 (0.8.8): the agent's own persona files refused to its file tools, as its config.toml is — the rule and its words are `tools/persona-files.ts`; 424 → 425 (0.8.17): `read` declares its lines kept exactly (`Tool.verbatim`), on the tool as `parallelSafe` is, so output by kind leaves them alone",
  },
  "apps/engine/src/modules/tools/approvals.store.ts": {
    lines: 523,
    why:
      "the approval gate: one table and the requests in flight — asked, queued one per chat, waited on by two clocks, " +
      "answered once, and kept across a restart (D8). Its state is one set of maps every step reads and writes, so the " +
      "restart's half stays with it; what reads on its own is beside it — the row mapping (`approval-rows.ts`), the " +
      "hand-over file and the answers nobody waited for (`approvals-kept.ts`). 0.7.11: the turn saying it waits, before " +
      "the prompt is shown (`asking`, stream 1.2), is in `wait`, beside the waiter it needs registered first. 0.7.14: " +
      "how a request settled, said once from `finish` — the one place every settlement passes — to the prompt that asked " +
      "it, with the answerer's name, and `get` for a press on it (G11); the prompt itself is `approval-prompts.ts`. " +
      "0.8.0 (464 → 466): the daemon's hint under `careful` carried from the question to its notice — shown, never stored; 466 → 486 for a job's grant (0.8.0): kept with the request like the exec and tool grants beside it, handed across a restart, and written on the job when the answer is always — the same ordering rule, before the call it allows runs; 0.8.7 (486 → 511): `settled`, the answered requests the table already keeps, for `work` and `nouride approvals --all`; and `allowedBefore`, the yes *Approve similar from this mission* gave, asked first and audited where every other answer is; 511 → 514: one line per chat a person reads — a mission's questions wait in the line of the chat they are put to (`askedIn`, `chatShowing`), the prompt on screen is told when the count behind it changes (`held`), and a pending request says whether its chat shows it yet (`queued`) — the floor is this gate's state, so its key and its reading are here; 514 → 516 (0.8.9, N5): the class a request is asked under, stored with its row and carried on its notice — who may answer reads it; 516 → 520: `previewOf`, and the id an approved outcome carries (0.8.13) — what a request showed, read back by the store that keeps it, for the persona write; 520 → 523: the preview on the notice a new question is put in front of a chat with (0.8.13) — stored with the row and left off the notice, a chat showed a persona's diff only after a restart",
  },
  "apps/engine/src/modules/turns/turns.store.ts": {
    lines: 456,
    why:
      "the turn record and its columns in one place, the causes it names (`SCHEDULED`, and from 0.7.14 `EDITED` with the " +
      "message it names — a person's edit, G11 — beside the step's `editOf`; from 0.7.15 a helper's report; from 0.7.19 the " +
      "agent whose answer an ask in the background brought back) and the `pulse` its stream says (0.7.11); " +
      "412 → 431 for a delegate's own turn (0.7.26): its causes, the one clause every read of a conversation says to leave " +
      "it out (`OWN`) — beside the queries that say it, so they cannot disagree — and the children a deleted conversation " +
      "takes with it; 431 → 432 for the request line a turn keeps (`context`, its writer the stream's); " +
      "split it when a second concern arrives; 432 → 439 for `lastFrom` (0.8.0): which connection a person's accounts last wrote from, the morning line's way to them when they picked none — a read of turn_records, which is this store's; 439 → 447 for `stepsIn` (0.8.0): the steps a chat's turns took, counted as each turn's line counts them, which a mission's page says beside its turns — a read of this store's records and their steps; 447 → 456 for what a person last wrote in a chat (0.8.8), one query over the turns' own columns, which a mission's page quotes for its person's language",
  },
  "apps/engine/src/modules/missions/missions.ts": {
    lines: 574,
    why:
      "the missions' one service — start, the dispatcher, a turn's shape and its end, stop and continue — whose pure rules are " +
      "already apart (`decide.ts`, `page.ts`, `notices.ts`, `limits.ts`, `worktree.ts`); 400 → 402 for a mission's folder " +
      "moved into its worktree as it begins (0.8.1), kept on the mission where its every turn, check and page read it; 402 → 404: a turn's shape says when the mission works in a worktree of its own, so `delegate` offers `isolated` there only (0.8.1); " +
      "404 → 413: a turn in flight remembers when it was queued, and one queued a stall's time ago and never run is taken as lost — the in-flight mark is this service's, set where it queues and cleared where it shapes; " +
      "413 → 420: a mission begins from its row as it is once its worktree is made, not the copy it started with — one stopped or deleted meanwhile is not begun, and the worktree made for it is removed; " +
      "420 → 424: a parent waits for a mission it handed out as for a job of its own, and its page names them — read from this service's store, the line itself is `page.ts`'s; " +
      "424 → 434: what it keeps in memory for a mission goes when the mission ends, and a turn's end or a message after that does not make it again — the tables are this service's, so is letting them go, and their sizes are exposed for the test that holds it; " +
      "434 → 435: a turn held while its agent slept is queued again from its waking, not taken as lost with a second beside it; 435 → 436: an external agent's CLI session let go as a mission ends; 436 → 441 (0.8.7): a start's `branch` checked with git before the row is written, and the dispatcher's reason for a queued start kept with its queue notice and handed back to the tool; 441 → 481 (0.8.7): an agent's own missions for `work` (`ownedBy`), done outside its checks, the same-repo reminder's lookup, the chat's notes told of a waiting question (`carryWait`), a question's option buttons, the worktrees it made itself tidied at its end, and the delegations to `counts.ts` for a CLI's tokens and the limits that hold — each the service's own act on its row, the rules apart in `decide.ts`, `counts.ts`, `carry.ts`, `options.ts`, `worktree.ts`; 481 → 500 (0.8.7): a turn its model could not answer pauses the mission and the timer tries it again (`retryAttempt`, `retryNow`, the goes-on line) — kept here because each reads and resets the turn state this class alone holds; a done mission closing its checklist step, one line; 500 → 503 (0.8.8): which limits hold and whether its tokens are known, for the dashboard's meters — read from this service's counts, as its line is; 503 → 506 (0.8.8): whether a turn running now has said done, ask or fail, which the minute's check reads before it stops a coding CLI's turn — the claim is this service's; 506 → 510 (0.8.8): when that claim was made, so a CLI turn that said done and works on is stopped at a limit once the claim is old; 510 → 512 (0.8.8): the claim time cleared with the claim at a turn's start and end, so a claim said again does not put a limit off; 512 → 521 for what a mission has spent beyond its count and the limits it was stopped at (0.8.8): read by the minute's check and a person's continue, held here with the counts and the wait they belong to — the rules are `decide.ts`; 521 → 522 for the turn a mission was started in, whose start bounds the chat's work that moves into it (0.8.8, `carry.ts`); 522 → 526 for `spent`, what a mission's CLI said it spent handed to the timers' limit check (0.8.8) — the reading is `timers.ts`; 526 → 540 for `tell` and `toldRead` (0.8.10), verbs beside answer and continue whose rules are `tell.ts`, and a turn's page marking the words told it as read where the page is made; 540 → 543 for `reviewing` (0.8.10): the reviewer at work, read through this service, which the routes hold — the passes are `checking.ts`'s; 543 → 558 (0.8.11): drafts — a draft announced when it is made and changed by `edit`, where it is its notice and folder (the rest is `drafts.ts` and `draft-edit.ts`); the person's words a mission started at once on, quoted in its *started*; a dropped draft's folder removed with it; its brief's path and text for the tool and the dashboard; and the queue asked again once a mission is being checked, which no longer holds its agent's slot; 558 → 561 for the brief the dashboard shows (0.8.11): its own `BRIEF.md`, else one its goal names inside its agent's folder, with where it is — the service's one read of a brief, beside `briefPath`; 561 → 564: `delete`, a person deleting an ended mission (0.8.13) — the service's own door to `person.ts`, as stop and continue are; 0.8.15 (564 → 573): `forStatus`, an agent's missions at work and waiting for a person, for its status; 573 → 574 (0.8.22): a question listed with the options the agent named, `options.ts` `withOptions`, where every ask is recorded, so the chat, the dashboard and the agent's page read one text",
  },
  "apps/engine/src/modules/pipeline/index.ts": {
    lines: 533,
    why:
      "the composition root, which builds what an arriving message passes through; 0.7.17's capture of credentials " +
      "sent in chat is one of those, shared by the arrival and the `/secret` command, so it is built here — with the " +
      "way a message `/secret undo` puts back arrives, as one from its platform would, through the parts `attach` built; " +
      "412 → 426 for `agentStatus` (0.7.18): what an agent is doing reads the running turns, jobs, approvals and providers " +
      "this root holds, and `/status` and the hooks both ask it here — the decision itself is `agent-status.ts`; " +
      "426 → 433 for `/mention` (0.7.18): a command about the group is answered before routing, a step of what an arriving " +
      "message passes through, and its hook is handed the admin check and the claim this root holds — the rest is `room-mention.ts`; 433 → 439 for a group command answered in the orchestrator's voice (0.7.18): it is told which connections are up, so another bot's copy waits for the orchestrator's own only where that bot can answer; " +
      "439 → 444 for an ask that moves to the background (0.7.19): `askRunner` is the tool's other half, built where the " +
      "subagent and peer runners are, and `/stop` says what it stopped there, helpers and asks — the rest is `background-ask.ts`; " +
      "444 → 452 for `messageSender` (0.7.23): `send_message`'s two closures over the deps, the chat types and the turns this root holds, beside `sendAttachment` — the rest is `send-message.ts`; " +
      "452 → 460 for the Groups page (0.7.24): the rooms the daemon knows and a rename read the deps and chat types this root holds — the rest is `known-rooms.ts`; " +
      "460 → 464 for asking an unnamed room's platform as it is listed, through the gateways this root holds; " +
      "464 → 468 for telling the agent a delegate in the background reports to how long it has run (0.7.25): the jobs and the job wakes are this root's — the rest is `budget-nudges.ts`; " +
      "468 → 470 for admission asking who a reply is for with the connection's owner (0.7.26): the gateways config is this root's — the rest is `Voice.replyAuthor`; " +
      "470 → 472 for work notes (0.7.26): `/notes` and `/reset` read them, and a deleted conversation clears them, through the deps this root holds — the rest is `modules/notes/`; " +
      "472 → 475 for `queueTurn` (0.8.0): a mission's turn goes into the queue every chat's does, and `/mission` reaches the missions through the hooks this root builds; " +
      "475 → 480 for asleep (0.8.0): what an asleep agent was sent waits for it, and its wake puts it back into this root's queue (`asleep.ts` holds it); 480 → 481 for `/schedule`'s proposals handed to the hooks (0.8.0); 481 → 484 for `reachableChats` (0.8.0): what `GET /chats` names for the Schedule and Webhooks forms is send_message's own list, built from the deps and chat types this root holds — the rest is `send-message.ts`; 484 → 486 for the external agents (0.8.1): their CLIs stopped once the queue drains at a shutdown, and a CLI's state as the agent's status; 486 → 487: an ended conversation's CLI session let go, through the external agents this root holds — the rest is `conversation-end.ts`; 487 → 496 for `wakeForOwnWords` (0.8.6): what an external agent's CLI says by itself wakes its chat through this root's queue, once the agent is free there, as a job's end does — the envelope is `own-words-wake.ts`; 496 → 503: `cliCommands`, what those CLIs left running in the background, read by a restart where it reads the queue, and `wakeForCliStopped`, the chat told of one a stop cut off; 503 → 505 (0.8.8): `/status` asks the external agents this root holds what answers a CLI agent — the lines are `hooks/cli-status.ts`; 505 → 508 (0.8.8): a line from the daemon into the chat a tool call came from, a closure as `send_message`'s are, for `agent_configure` telling the person an agent moved its coding CLI to another model — the line is `send-message.ts`; 508 → 518 for a mission's `tell` into its turn at work, how a steer reaches an agent and where a read tell is marked (0.8.10) — the rules are `steering.ts` and `active-turns.ts`; 518 → 521 (0.8.11): `chatTypeOf`, whether a chat is a room as this root's chat types saw it, for the dashboard links a mission's notice carries — the rule is `web/links.ts`; 0.8.15 (521 → 522): a coding CLI's command left running and missions at work in an agent's status; 522 → 523 for handing the hooks the efforts an agent's CLI offers (`cliEfforts`, 0.8.16), from the external agents this root holds; 523 → 527 for `/btw` (0.8.17): the side questions, built beside the turn context and handed to the hooks as `compactSession` is; 527 → 528 for `/effort … lock` (0.8.17): the write of an agent's own effort handed to the hooks with the admin check this root holds, as `/mention`'s and `/secret`'s are; 528 → 529 (0.8.18): a chat's `/model` and `/effort` are read from its conversation's row, so their holder is built in the constructor over the sessions store this root is handed, where a field initializer cannot reach `deps`; 529 → 533 for `sayInChat` (0.8.23): a line said in a chat for an agent outside any turn and kept in its conversation, which the turn context this root holds does; the doing is `send-message.ts`",
  },
  "packages/gateways/src/channels/discord/gateway.ts": {
    lines: 426,
    why:
      "one Discord connection: its client's events, sends in parts with the pace Discord allows, edits, files and buttons, " +
      "and its reconnect; 0.8.0 adds the bot's presence following its agent, kept so a new session shows it again; 408 → 416 for a person's DM opened by their account (0.8.0): a user id names no channel, and the morning line and send_message address a person by it — the channel lookup is this adapter's; 416 → 418: a message with buttons rewritten with them kept (0.8.7) — an open approval saying how many wait behind it — in the method that settles them; 418 → 419 (0.8.7): the import of `heartbeat.ts`, where its liveness check now lives — judged only once its first heartbeat was due; 419 → 426 (0.8.12): whether this bot may view a channel (`Gateway.sees`), read from the client's cache beside `roomTitle`, the other question it answers about a room",
  },
  "apps/engine/src/modules/pipeline/attachments.ts": {
    lines: 409,
    why:
      "the one place a message's files become what the agent gets — stored, a picture shown or described, a video's " +
      "frames and sound, a clip heard or transcribed — and the note that says which; 400 → 409 for an agent a coding CLI " +
      "answers (0.8.7): what it takes is the CLI's own word at its handshake, decided here for its pictures, its sound and " +
      "the pictures carried in from earlier, so the note and the parts cannot disagree",
  },
  "apps/engine/src/modules/pipeline/inbound.ts": {
    lines: 412,
    why:
      "whether a message gets a turn at all, and whose — every early return together, in the order that is the point of " +
      "the file; 0.8.0 adds an asleep agent's two answers (kept for its waking, or told once an hour) and a mission's " +
      "turn handed to the missions to shape; 404 → 412 for `abandoned` (0.8.15): a turn that threw before its own end could run gives the chat back, closes its record and tells the person — where admit's rejection is reported, the one place it is seen",
  },
  "apps/engine/src/modules/pipeline/turn.ts": {
    lines: 508,
    why:
      "running a turn: its executor, its meter, its cause and what a compaction before the answer left; its settle " +
      "handles the message it answered in the same commit (E7), it tells its executor what the message carried " +
      "from outside (S13), and who writes its summaries before the answer and after it (`llm/summarizer.ts`, one " +
      "route for both, M12), and the call ids its helpers and peers share with it (0.7.11); 425 → 428 for a thread's opening " +
      "message (0.7.24): put in front of the first question there, where the question is composed; 428 → 438 for the " +
      "opening line before long work (0.7.24): which turns get one and how it is sent are decided where the turn's " +
      "envelope and voice are, the rule itself is `preamble.ts`, and the answer is not sent twice where it is sent; 438 → 440 for keeping an opening line that calls another agent for the answer, so a room does not start that agent twice; " +
      "440 → 444 for the reply budget (0.7.25): the turns a person waits on are the ones the opening line is for, decided here, and its watch is stopped where the turn's clock is — the rule and the words are `budget-nudges.ts`; " +
      "444 → 445 for the line each model request writes to the turn's record (0.7.26): wired where its other sinks are, the line itself is `context-line.ts`; 445 → 446: the executor is told who installs the programs every agent runs — the orchestrator, `toolchain/shared-tools.ts` (0.8.0); " +
      "446 → 467 for a mission's turn (0.8.0, `turn-shape.ts`): started from its page and not its history, run as the person who started it, its approvals parked, and the mission told how it ended — on every path a turn ends by, which is why it is here; 467 → 468 for whether the long reply's note may say to hand the rest to a mission; " +
      "468 → 469 for a turn stopped at its next step when its agent is put to sleep, closed as a stop rather than a restart; 469 → 482 for work nobody watches (0.8.0): a mission's or a scheduled chat turn's goal and chat handed to the turn, and the second look built for it with the turn's own level, provider and meter; 482 → 483 for the `Unattended` type a turn hands its executor (0.8.0); 483 → 484: the level resolved once for the executor and its second look, so a scheduled job's turn here is held below `trusted` in both (0.8.1) — the rule is `chatTurnLevel`; 484 → 487: the bubble closed before the agent's words go out, where the line's send is built (0.8.5) — the closing is `ChatProgress.seal`; 487 → 489: a turn woken for what an external agent's CLI said by itself is told so, read from its cause where the request is built (0.8.6) — the reading is `external-agents/own-words.ts`; 0.8.7 (489 → 492): a coding CLI's mission turn runs on a clock that each step restarts (`turn-clock.ts`), wired where the turn's timer is; 492 → 497: the reply as it is written reaches the bubble too, which says the model is writing once its steps are done, and the bubble's tick a test can shorten — wired where the bubble is built; the line itself is `ChatProgress`'s; 497 → 505 for a turn's listener for what is put in front of it, handed to a coding CLI's runner so it hands steers over mid-prompt (0.8.10, `external-agents/steering.ts`); 505 → 506: beside it, whether the line in the agent's own words is still being written, which that runner waits on so the CLI reads the two together (`steer-reply.ts`); 506 → 508 for the chat's `/effort` level its model refused (0.8.17): said under the answer that met it, once, where the reply is composed",
  },
  "scripts/build/core.ts": {
    lines: 405,
    why:
      "the release build in the order a tarball is made: compile, check what is embedded and what is not, stage what goes " +
      "beside the binary, pack, say what was built. 400 → 405 (0.8.0): `run/nouride-run`, the helper every Linux tarball " +
      "carries, staged beside `pkg/` — built in `build/nouride-run.ts`; the staging list is the seam when it next grows",
  },
  "scripts/check-sql.ts": {
    lines: 492,
    why:
      "the SQL lint: one reader of the code's SQL (the literals, the queries in a loop) and three judges of what it read — " +
      "482 → 483: `SCANS_ALLOWED` names `skill_reviews`, one row a week (0.7.27); " +
      "the text rules, the query plans against a migrated database, the floors that prove it read anything. The plan " +
      "half (`planFindings`, `forPlanning`, `reads`) is the seam when it next grows. 481 → 482: `SCANS_ALLOWED` names the " +
      "MCP registry's copy (0.7.19) — a line of the list, not of the lint; 483 → 486: `SCANNING_STORES`, the one-time step that renames paths under a folder moved out of `data/` (0.8.0) — narrower than naming the tables it reads; 486 → 489: `QUERIES_PER_ITEM`'s first entry, memory's paged sweep (0.8.0) — a line of the list, its reason with it; " +
      "489 → 492: the knowledge base's tables in `SCANS_ALLOWED` and its collection list in `INTERPOLATIONS` (0.8.20) — lines of the lists",
  },
  "apps/engine/src/index.ts": {
    lines: 587,
    why:
      "boot order and graceful shutdown — what is not ordering is lifted into `boot/`, and what is left is the sequence; " +
      "570 → 586 for the knowledge base (0.8.20): who its admins are, known once the accounts are opened, and its wait for room, " +
      "once the box's load is sampled, both after memory is built — two steps of the sequence — its look at the folder among the timers, " +
      "and the built-in skills handed to memory, whose `doc.py` reads PDF and Office files; " +
      "481 → 489 in 0.8.0 for the spend alerts, built after the notifier they speak through and before the pipeline that " +
      "tells them each turn's verdict — a step of the sequence (`llm/spend-alerts.ts`); 489 → 491 for 0.7's " +
      "`fallback_model` written forward in every pack before the packs load, gone again in 0.8.1 with 0.8.0 the floor; " +
      "462 → 466 for skill learning's stores — candidates, reviews, the audit's reads — built beside the drafts' (0.7.27); " +
      "466 → 462 in 0.8.0: 0.7.x's rewrites at boot gone — the MCP fold, the config's and the packs' forms brought " +
      "forward, what they held the last-run record on — and 0.8.0's upgrade floor, checked before the data directory is " +
      "locked or written, and the memory vault's format, read before the database is migrated so a refused vault leaves " +
      "the schema as it was, added — steps of the sequence, their order the point (`boot/upgrade-floor.ts`, `boot/memory.ts`); " +
      "the data directory's lock is `boot/lock.ts`'s, which knows what a holder looks like (one import), and the " +
      "version that last ran is recorded the moment the daemon is ready, a step of the sequence (`boot/last-run.ts`); " +
      "the files a restart reads back (paused agents, alert cooldowns: D15) are handed to their stores where those are built, " +
      "the pipeline is told whether this is a Box once the plugin knows (E7), and the approvals a restart keeps are carried " +
      "over before the gateways connect and asked again once they have (D8) — two steps of the sequence itself; and the " +
      "context's live view of the registry for `/health` (failed packs), one line where the context is built; and each " +
      "agent's model listing asked once the daemon is ready (G2) — after the bundled gateway, so a step of the sequence; " +
      "0.7.17's credentials held from chat are made with the store, before the providers, so every request is masked of " +
      "what the daemon knows from the first, and every connection is masked once all of them exist; with them, where the " +
      "store and the control token are and what the daemon's own credential files hold — read where the store is opened; " +
      "437 → 439 for a group's own `groups_require_mention` (0.7.18): its store, made where the pipeline is given its stores; " +
      "439 → 442 for the MCP registry's copy (0.7.19): built once over the database and handed to both the agents' tools " +
      "(`mcp_search`) and the control plane (the Explore tab) — the one place that has both; " +
      "442 → 446 for the cgroup the daemon splits for agents' commands (0.7.19): made first, before anything is " +
      "spawned — a step of the sequence by definition — reported once the logger is, and carried on the context for `/health`; " +
      "446 → 450 for remote MCP servers' logins (0.7.19): built over the database, the store and the notifier before the " +
      "connections, which reach every remote server through them, and handed to the control plane — the one place that has both; " +
      "450 → 454 for 0.7.19–0.7.22's rewrites at boot (gone in 0.8.0, above); 454 → 456 for room names (0.7.24): their store, made where the pipeline is given its stores; " +
      "456 → 458 for helper models' trouble on `/health` (0.7.25): read from the log store, one line where the context is built; " +
      "458 → 462 for work notes (0.7.26): one store, made where the other stores are and handed to the pipeline, the tools, the control plane and the daily sweep; 462 → 468 for 0.8.0's isolation: what agents' commands read settled beside `data/` and whether each agent's commands run as its own user, once the database is open and before anything is handed a path, then every agent made ready once the registry has loaded them and each one again when it loads — steps of the sequence (`boot/kept-folders.ts`, `boot/agent-users.ts`); 468 → 469: the context carries how agents' commands reach their own users, for `/health` and so `doctor` can tell a socket gone from a host without one; 469 → 471: the agents made ready in the background, with what went wrong said — the first start hands some 450,000 files over on the live box, and boot does not wait on it; 471 → 472: skill learning is handed the install's `[llm.defaults]` by reference beside its own section, for a `model` that names a tier (0.8.0) — where the engine is built; " +
      "472 → 480 for the missions (0.8.0): built before the pipeline that shapes their turns, joined to it and the tools once both exist, and resumed after the restart's own debts are paid — steps of the sequence (`boot/missions.ts`); " +
      "480 → 481 for each bot showing its agent's status, started beside the missions (`boot/presence.ts`); " +
      "481 → 484 for the box's load (0.8.0): made once, sampling from before the nightly pass's first look, and handed to " +
      "the pass, its timer cleared at shutdown with the others (`commons/box-load.ts`); 484 → 485: handed to the pipeline " +
      "too, for its background helpers to wait for room — where the pipeline is given what it needs; with 0.8.0's spend " +
      "alerts and fallbacks above, 495; 495 → 500 for 0.8.0's scheduled work: the proposals built (`boot/proposals.ts`), the `schedule` tool and `/schedule` handed to the pipeline, and every connection's presses routed to approvals and proposals alike; 500 → 502 for the morning lines started with the other timers (0.8.0, `boot/morning-lines.ts`); 502 → 506 for *always for this job* (0.8.0): the approval gate writes it on a job through the cron store, and a job's mission reads it each turn — two closures over the stores this root builds; 506 → 510 for the external agents (0.8.1): made before the agents load, which read the CLIs it knows, and handed to the pipeline — a step of the sequence (`boot/external-agents.ts`); 510 → 514: when the daemon first saw each agent (0.8.1, `commons/agents-seen.ts`) — made at boot beside the registry, noted for those loaded now and for each one loaded later, and handed to the control plane; 514 → 515: the coding CLIs handed to `agent_create`, so an agent can make an external agent from a chat (0.8.1); 515 → 516: a reloaded pack's skills copied to its external agent's CLI as it reloads (0.8.1) — a listener on the registry, which this root makes after the external agents; 516 → 517: the registry is given the start's external-orchestrator check for each reload of a pack (0.8.1, `boot/preflight.ts`), so a save that makes the orchestrator external is put back — an option where the registry is made, the one place that has both; 517 → 518: a mission's coding-CLI session let go when it ends, wired to the service that holds them; 518 → 519: each agent's own folder handed to the MCP manager, where its stdio servers start as its own user (0.8.1); 519 → 521: what an external agent's CLI says by itself wakes its chat, joined once the pipeline exists, and a command one had left running, which the last process was stopped with, is told after the inbox reopens (0.8.6); 0.8.7 (521 → 524): the missions' option presses routed with the others, their prompts naming the mission and offering *Approve similar*, and the gate asking what that allowed — wiring, in the order the rest is; 524 → 526: the gate told where a mission's question is put (`askedIn`, the one line per chat) and the prompts told when the count behind one changes — two options where the gate is made, the one place that has both; 526 → 527 (0.8.8): the missions are told whether nothing asks before an agent deletes, from the external agents built before them — the decision is `ExternalAgents.freeToDelete`; 527 → 530 (0.8.8): the `persona` tool built for the pipeline, with the Files tab's one write it applies an approved change through — the tool is `tools/builtins/persona.ts`; 530 → 531 (0.8.8): a coding-CLI agent's CLI handed to the tools — its name, the models it offers and the one it runs on — for `agent_configure` to set its model, from the external agents built before them; 531 → 533 for the two readings the missions take from services built before them (0.8.8): a running CLI turn's tokens so far, from the external agents, and what a person last wrote in a chat, from the turns — each a line of the `buildMissions` call; 533 → 534 for when a turn started, read by a mission's start: only the chat's work of the turn that started it moves into it (0.8.8); 534 → 535 for a mission's CLI turn's spend joined to the missions once both exist: its limits read as the CLI says it (0.8.8); 535 → 537 for the admin-only question's copies in each admin's own chat (0.8.10, `boot/admin-chats.ts`), wired where the prompts are; 537 → 538: the agents' credentials handed to the missions, so a `report.md` holding one is refused as `send_file` refuses a file (0.8.11) — a line of the `buildMissions` call; 538 → 548 (0.8.11): the one rule for a dashboard link in a chat, bound here to the live config, the accounts and the pipeline's chat types (`web/links.ts`), and handed to the missions, the proposals and the tools; the accounts store made once, before it, for that rule and the pipeline both; the notifier told to send a message holding a link with its preview off; 548 → 549 (0.8.11): the audit log handed to the missions, where a mission started on a person's words — at once, or a draft on their go — is recorded with them; 549 → 559: the skills watch (0.8.13) — its folders, its refresh, its listener and its timer, lifted into `boot/skills-watch.ts` but wired in the boot order like presence; 559 → 564 (0.8.18): the daemon's own state in the database, its old files moved in, then the install's folder settled and a moved install's paths renamed — two steps right after the database opens, before anything reads either (`boot/state-files.ts`, `boot/install-root.ts`), and the state handed to the four readers that took a file; 564 → 570 (0.8.19): the secret store opened encrypted from where the install keeps its key, settled after the context (its sealed copy kept current, `secrets.json` moved once no update is pending: `boot/secret-store.ts`), and its fields handed to the prompt's credentials line; 586 → 587 for memory's audit log (0.8.23): the documents a conversation opened are read from it when it is filed, and boot hands it over here, where both are built",
  },
  "apps/dashboard/src/commons/lib/api.ts": {
    lines: 431,
    why:
      "the shapes every page shares — health, status, agents, chat — with each menu's own calls and types in an `api.<menu>.ts` beside it; " +
      "413 → 416 for an agent's `fallbacks`, a list of `FallbackPair` in its summary (0.8.0); " +
      "400 → 401 for `/status`'s `helpers` (0.7.26), one field on the status every page reads, its type in `api.memory.ts` with the card that shows it; " +
      "401 → 404 for a turn's record (0.7.26): `api.turns.ts` spread into `api` and its types re-exported, as every module of calls is — the calls and types are there; " +
      "404 → 406 for a conversation's work notes (0.7.26): `api.notes.ts` imported and spread into `api` like every other menu's calls — the calls and types are there; 406 → 410 for the model tiers (0.8.0): `api.tiers.ts` imported, re-exported and spread like the others, and `/status`'s per-agent `tiers` beside its `fallbackModel`; 410 → 413 for missions (0.8.0): `api.missions.ts` imported, re-exported and spread like the others — the calls and types are there; 416 → 417 for an agent's second look on the status row (0.8.0); 417 → 420 for external agents (0.8.1): `api.external-agents.ts` imported and spread like the others, and an agent's `external` CLI on its status row; 420 → 422 for an agent's `look` on its status row (0.8.1), its type from `api.look.ts`; 422 → 423: an agent's `since` on its status row, when the daemon first saw it (0.8.1), the order Nouride Office fills up in; 423 → 424: a pending approval's `queued` (0.8.7), not asked in its chat yet — one field on the request every approval card reads; 424 → 425 for an agent's own `missionsPerAgent` in its summary (0.8.11), as `maxBackgroundHelpers` is; 0.8.15 (425 → 427): an agent's missions at work, and waiting for a person, in its activity; 427 → 429 for an agent's effort and the install's on its status row (0.8.17), which its Model tab chooses; 429 → 431 for the knowledge base (0.8.20): `api.knowledge.ts` imported and spread like the others — the calls and types are there",
  },
  "packages/gateways/src/channels/whatsapp/gateway.ts": {
    lines: 417,
    why:
      "the WhatsApp adapter's one state machine — bridge reachable, number linked, pending sends — which every handler of a " +
      "bridge event reads and writes; 400 → 412 for a lost link (0.7.26): when it was lost, a new bridge's grace, `ping` saying " +
      "down after three minutes, sends held until the link and flushed on `ready`. Moving the link state out would split one " +
      "machine across two files that must agree; 412 → 417 for WhatsApp's own reconnect pacing (0.8.0), which the engine " +
      "handed it from a gateway's `[resilience]` table until then: a fact about this platform, so this adapter's",
  },
};

/** Test files over `MAX_TEST_CODE_LINES`; new cases go in a file of their own. */
export const TEST_BUDGET: Record<string, Budget> = {
  "apps/engine/tests/pipeline/pipeline.test.ts": { lines: 3_828, why: "the pipeline's first suite, from before the pipeline was split; new cases go beside the module they test — and the peer line its second pack carries, asserted where a turn and /prompt build OTHER AGENTS; a job record's fixture carries the helper's fields since 0.7.15, one line; 3_710 → 3_735 for a daemon event that quotes `@name` running only the agent it names (0.7.17, #10), which needs this harness's two agents on one connection; 3_735 → 3_744 for a stopped turn not counted against its provider (0.8.12), beside the provider-health case it mirrors and on this harness's `providerErrors` and hanging fetch; 3_744 → 3_746 for the quiet wake-up logged at info, in the full-stop case it belongs to; 3_746 → 3_765 for an agent speaking through another's bot reaching that bot's agent by its handle (0.8.12, found live in the sandbox), beside the two handle-handover cases it completes, on this harness's gateways and their selfMention; 3_765 → 3_792 for a scheduled turn in a room only the room log knows handing its tag over (0.8.12, found live in the owner's group), beside them, on the same two bots; 3_792 → 3_802 for an agent whose own bot cannot read the room said to be out of it (0.8.12, live on Discord), in the room wake-up cases on this harness's two gateways; 3_802 → 3_828 for a tag of an agent whose bot cannot read the room followed by a line saying so (0.8.12, live on Discord), beside the handover cases on the same two bots" },
  "apps/engine/tests/persona/reflection.test.ts": {
    lines: 2_075,
    why: "reflection end to end, written before `modules/reflection` was split; 2_046 → 2_052 for 0.7.27 — the large-skill case's new stance, the fixture split into `[skills.learning]` and the pass's own tuning, and `/drafts approve` saying on for the agent that learned it, not every agent; 2_052 → 2_075 for 0.8.12 — the pass drafts nothing for a skill that ships with Nouride or one a person wrote, beside the built-in cases it completes, on this file's `enginePointedAt` (which now hands back its drafts and revise calls); new cases go to tests/reflection/",
  },
  "apps/dashboard/tests/mount.test.ts": {
    lines: 1_799,
    why:
      "every page mounted, the memory graph's too, and the cases that click through one — 2_051 → 1_796 when its harness " +
      "(the fake DOM, fetch and hooks, renderPage, press/type/recordPosts) moved to `mount-harness.ts` (0.8.0), as this " +
      "entry said it would the next time the file grew: a page's new cases can now go in a file of their own; 1_796 → 1_798 " +
      "for the Missions list's tabs, one per way a mission finished (0.8.0) — an existing case, changed where it stands; " +
      "1_798 → 1_799 for the second look's card saying what it does in words the owner could read (0.8.0), asserted in its existing case.",
  },
  "apps/engine/tests/llm/prompt.test.ts": { lines: 1_041, why: "prompt assembly, every section and its order — and, since 0.7.11, the formatting line a connection gives or the browser's; how a kept secret reaches commands; 0.7.23: the `send_message` line, beside `send_file`'s, and the database ruled out; 0.7.26: the reader that puts who is speaking after the system prompt, where it is sent now; 0.8.12 (1,025 → 1,039): the skills list shortened before the agent's memory is trimmed, beside the trim test it extends; 0.8.15 (1,039 → 1,041): trusted's exec line now names what every level still asks, its whole words asserted" },
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
