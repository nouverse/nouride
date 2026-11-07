/**
 * What the built-in tool schemas cost, held where it is.
 *
 * Every definition an agent holds is re-sent on every request of every tool iteration. Cached on
 * Anthropic, implicitly prefix-matched on OpenAI, and on both it spends the window at full size. The
 * descriptions are not padding — most sentences in them are there because of something that went
 * wrong live — so this does not ask for them to shrink. It asks that growth be a decision: a tool
 * past its ceiling, or the set past its total, fails here and has to be argued for.
 *
 * Measured, not estimated: characters of the JSON the provider receives. Raise a number in the same
 * change that needs it, with the reason in the commit.
 */

import { describe, expect, test } from "bun:test";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import { createPersonaTool } from "@/modules/tools/builtins/persona.ts";

/** Every optional dependency present, so every conditional tool is built. Their values are never called. */
const stub = new Proxy({}, { get: () => () => ({}) });

const tools = createBuiltinTools({
  security: DEFAULT_CONFIG.security,
  startJob: (() => ({})) as never,
  memory: stub as never,
  sendFile: stub as never,
  attachmentRead: stub as never,
  nourideCli: { binary: "/bin/nouride", installDir: "/srv/nouride" } as never,
  update: stub as never,
  people: stub as never,
  sessionStatus: stub as never,
  runSubagent: stub as never,
  askAgent: stub as never,
  harness: stub as never,
  reflection: stub as never,
  mcpCatalog: { catalog: stub as never, linkFor: () => null },
  notes: stub as never,
});

// `mission` is resolved by the daemon, not the registry, and its chat shape rides on every chat turn's request (0.8.0).
tools.set("mission", createMissionTools(stub as never).chat);
// `work` the same way (0.8.7): every agent that holds a tool carries it.
tools.set("work", createWorkTool(stub as never));
// `schedule` the same way (0.8.0).
tools.set("schedule", createScheduleTool({ store: stub as never, timezone: () => "UTC", agentExists: () => true, post: async () => true }));
// `persona` the same way (0.8.8).
tools.set("persona", createPersonaTool({ files: stub as never }));

const size = (name: string) => JSON.stringify(tools.get(name)!.definition).length;

/** The largest any one tool may be. The biggest today is `exec`, at about 2.8k. */
// 2,900 since exec's `keep_working`: a background job ended the turn even when the agent had other work
// that did not need its result, and the parameter has to say when to leave it off. 3,000 since `mission` (0.8.11, ~2,980):
// when work is a mission's, who signs a draft off, and where a worktree comes from — code in a repository only. Asked to
// audit a spreadsheet, Nouva ran `git init` in its folder because the checks said "a commit is on a local branch".
// 3,100 for `mission`'s `no_review` and `accept` (0.8.11, ~120, at ~3,100): who signs a draft off is chosen with them,
// and `no_review` said only "the checks are the whole answer" — which no check of a translation is — so Nouva drafted
// with the reviewer for a person following the work in the chat. They say the rule now.
// 3,400 for `mission`'s rule (0.8.17, ~270, at ~3,370): what a mission is for, the owner's bar of more than about an
// hour with his examples (long development, a deep analysis, a long scan, research, a migration) and what it gives (it
// keeps going on its own and proves itself done), and shorter work sent to a helper or another agent in the
// background. "Many steps or items" had drafted missions for work of ten minutes, which a background helper does.
const PER_TOOL = 3_400;
/** All of them together, which no single agent holds but the default-rich ones come close to. */
// 32,500 since exec's `service`: a server started as an ordinary job ended the turn and never woke it,
// and the parameter that fixes it has to say when to use it instead of `background`. 32,800 since
// exec's `keep_working`, for the reason above. 33,900 since `person_notes`: what does not change about the
// person speaking had nowhere to go but memory, and the tool has to say whose notes it changes — theirs
// only, at their word — and what goes to memory instead. 34,500 since `delegate`'s brief and `background`
// (0.7.15): a brief with an empty context is refused, so the schema names its four parts and what each is
// for, and `background` is the parameter that keeps an agent free for the person — it has to say the turn
// ends and the result comes back as a message, or the model waits for one. 34,750 since `ask_agent`'s
// `background` (0.7.19): an ask that runs long moves to the background by itself after a minute, and the
// parameter is for work the model knows is long from the start — it has to say the answer comes back as a
// message, and what happens without it, or the model waits for an answer that is not coming in this turn.
// 35,100 since `mcp_search` (0.7.19), 317 characters, built here only once this test gave the registry its catalog:
// "*" never offered it, and nothing compared the two until then. 35,400 since `write`'s `append` (0.7.25): a whole
// document in one call's arguments ran into the reply's output limit and arrived cut three times running, and the
// parameter that writes it in parts has to say what it is for, or the model sends the giant call again. 35,650 since
// `ask_agent`'s task says how far a brief reaches (0.7.25): a brief that deleted three datasets also asked for a root
// cause, with no stop, and ran fourteen minutes on a production machine. `delegate` says it in the harness's delegation
// lines instead, which it already has. 36,950 since work notes (0.7.26): `notes`, 560 characters, and `plan`'s `task`
// and `skipped` — a four-hour audit lost which documents were done and the person's rules to compaction (2026-10-20),
// and the place a model is told how to keep them is the tool it keeps them with. 37,000 since `nouride`'s stdin says a
// handle there is replaced by its value (0.7.26): the model that saved two bots' tokens as `$TMP_SECRET_…` said in its
// reasoning it could not tell whether stdin would expand one. 37,150 since `notes` says a task's progress goes in its own
// section (0.7.26): one audit became six tasks, a new one per status update, until a write was refused at the cap.
// 37,200 since `skill_create` is checked like a draft and on for its author (0.7.27): an agent asked to save one task's
// steps wrote a skill named after the task, with the host's address in it, on for six agents — the tool has to say what
// it refuses and who has the result. 37,470 since `tier` on `delegate` and `ask_agent` (0.8.0): which of three models the
// work it starts runs on — the enum and one line each; what each tier is for and costs is said once, in TOOLS. 38,790
// since missions (0.8.0): `mission`, counted here from now on at ~1,210 — when work is long enough to run on its own,
// in the words a model decides by — and `plan`'s `note`, since a mission's next turn starts from its checklist and not
// its history, so what a finished step left is said there or nowhere. 40,290 since `schedule` (0.8.0), ~1,490: work that
// runs later is proposed for a person to turn on — one tool instead of `nouride cron add`, whose raw command line a person
// approved — with its trigger in one field and each kind of work in a word. 41,800 since `agent_create`'s look words
// and its two models (0.8.1): on the live box the loader refused a guessed look word one part a try, and the CLI's model
// went into Nouride's own `[llm]` — the look's words are its enum now, and `model` and `external.model` say which is which.
// 41,850 since `mission` says when in minutes (0.8.5): the owner's line, past about ten, so long work in a chat — a
// refactor across many files — is handed over too, not only work left running while the person sleeps. 42,100 since
// 0.8.7: a mission's `goal` and `review` say "in English" (an agent's goal in another language is refused at start, and
// the field it writes is where it learns that before the refusal does), and `mission` takes a `branch` and says where
// its checks run (a repository with `feat/` names had its missions' work pushed from `mission/<id>` by hand, and a
// check run in the worktree is what proves the mission's own branch). 43,400 since 0.8.7's mission stability, ~1,220:
// `work`, ~1,030 — an agent read config.toml for the control token to see its own mission, and the tool that answers
// from the daemon instead has to name its ten actions — and `mission`'s start saying related work has one parent and
// a check proves an artifact, not an open PR (two missions each merged half of one job, and a check on a PR's state
// failed for reasons that were not the work's). 43,600 for `agent_configure`'s `effort` (0.8.7, ~190): asked to think
// harder, an agent — a coding CLI's above all — had no way to, the setting being a line in a file only an admin edits.
// 44,460 for 0.8.8 (~860): `persona`, ~650, counted here since every agent that holds a tool carries it — the file tools
// refuse an agent its own SOUL.md, IDENTITY.md and AGENTS.md, and this is the one way it says what should change in them,
// for an admin to decide; and a brief's words where it is written — a mission's goal is whole, each turn starting from it
// and not the conversation, and a long one points at a brief file; a proposed job's `prompt` is English and whole, its run
// starting with none of the conversation (both refused unless English, and the field is where the model learns it first).
// 44,600 for `agent_configure` on a coding CLI (0.8.8, ~140): its `model` is the CLI's, one it offers on the account, and
// the chat is told — refused outright before, an agent asked to use a larger model could not, and [llm] is not the one.
// 44,900 for `work`'s `tell` (0.8.10, ~280): what a person said in the chat for a running mission reached it only if the
// agent stopped and restarted it — the action passes their words on, and has to say they are the person's, word for
// word, and never change its goal, or an agent tells a mission its own idea of the work as theirs.
// 44,960 for `mission`'s "What other harnesses call `/goal` is a mission here." (0.8.10, ~55): a person asking for "goal
// mode", as Codex CLI and the others name it, got a long chat turn, and `/goal` was "Unknown command" — the sentence is
// the rule's own (`WHEN_TO_START`), so it is said where the rule is, the tool's description among them.
// 45,940 for drafts (0.8.11, ~980): `mission` in a chat drafts and edits — `brief`, `now` with the person's `said`, `edit`'s
// `id`, and who signs it off by who is there, in place of the minutes line — and `work` starts a draft on the person's
// word. A mission an agent started ran with a reviewer judging documents for a person who was there to read them.
// 46,080 for that `mission` change (0.8.11, ~140): `workdir` says a person's documents are worked on where they are
// and never in a repository made for the mission; `checks` prove the file, a commit only in a repository.
// 46,200 for `mission`'s `no_review` and `accept` saying who signs a draft off (0.8.11, ~120), for the reason above.
// 46,500 for `mission`'s rule (0.8.17, ~270), for the reason given at PER_TOOL.
// 47,100 for the knowledge base (0.8.20, ~570): `memory_search` finds documents kept for reference, in the language they
// are written in, and narrows to them with `kind`; `memory_read` opens one with `document`. Without the words an agent
// searched documents in English keywords, the way memory is searched, and missed an SOP written in Indonesian.
// 47,850 for `memory_write` keeping a document (0.8.20, ~730): `about` "knowledge" with its `collection`, `title`, `file`
// and `source` — a document, a file or a link a person hands over goes to the knowledge base, never into a profile or
// MEMORY.md, and the field is where the model learns which.
// 48,000 for `memory_write` saying a PDF or an Office file is read for its text (0.8.22, ~135): Nestor, asked to keep the
// owner's legal PDFs, did not know a PDF's text was read and planned to take the text out first, as "a file to keep as it
// is" said no more; and a scan, with no text, is kept but not searched, which the agent can say before it starts.
const TOTAL = 48_000;

describe("tool schema budget", () => {
  test("every conditional tool was built, so the total means what it says", () => {
    expect(tools.size).toBeGreaterThanOrEqual(28);
  });

  test(`no tool is over ${PER_TOOL} characters`, () => {
    const over = [...tools.keys()].filter((name) => size(name) > PER_TOOL).map((name) => `${name}: ${size(name)}`);
    expect(over).toEqual([]);
  });

  test(`all of them together stay under ${TOTAL} characters`, () => {
    const total = [...tools.keys()].reduce((sum, name) => sum + size(name), 0);
    expect(total).toBeLessThanOrEqual(TOTAL);
  });
});
