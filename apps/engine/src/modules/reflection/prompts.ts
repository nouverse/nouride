/**
 * What the reflection pass is told to do — the three instructions, and nothing that calls a provider.
 *
 * Split out of `synthesis.ts`, which sat exactly on its line budget, and the seam is real rather
 * than convenient: these are prose, they change for reasons of judgement rather than of code, and
 * the tests that matter most about them assert on the text itself. Keeping them beside the request
 * machinery meant every rewording moved a file full of retry handling and JSON parsing.
 *
 * `renderSkillList` comes too. It is the list the triage matches against, so it is as much a part of
 * the instruction as the rules that refer to its markers — and the markers and the rules have to
 * agree on their wording, which is easier to keep true when they are in one file.
 */

/**
 * When a skill's body has grown enough that new detail should go to `references/` instead.
 *
 * ## What this marker is for
 *
 * It first said "already N separate subjects" and pointed at a rule telling the pass to start a new
 * skill. That was backwards, and Hermes says so directly: the target shape is class-level skills
 * with a rich body and a `references/` directory, *not* a long flat list of one-session-one-subject
 * entries. A large skill is usually working as intended. What it needs is a pressure valve, and the
 * valve is `attach` — the detail moves to a file, the body keeps a pointer.
 *
 * ## Why it is one number
 *
 * Two earlier versions counted headings and both were wrong on real data.
 *
 * Counting `##` alone missed `domain-management` entirely — 23KB, four sections, because everything
 * it had absorbed went into subsections under one `## Workflow`. Twelve approvals in three hours,
 * never flagged. Counting `##` and `###` fixed that and then marked six of the seven largest skills,
 * including a 7.6KB one, which is a marker nobody reads.
 *
 * Size tracked it in both directions and the heading shape did not. Measured across the live pool:
 * everything sits at or below 13KB except two, and those two are the ones that had swallowed
 * subjects belonging elsewhere. What makes a skill unwieldy is how much an agent has to read before
 * it can act, and that is what this measures.
 */
const BROAD_SKILL_BYTES = 12_000;

/**
 * What the pass is told.
 *
 * This is where the intelligence lives now. The trigger only decides *whether to look* — see the
 * note at the top of `trigger.ts` for why judging a struggle by regex was the wrong shape. Every
 * hard question is here, asked of something that can read the conversation.
 *
 * The "do not capture" list is the valuable half and it is not ours: it is adapted from Hermes
 * Agent's `_SKILL_REVIEW_PROMPT` (its `agent/background_review.py`), which is a list of
 * ways a self-improving agent poisons itself that somebody clearly learned the hard way. Two of them
 * are worth reading twice — *negative claims about tools* harden into refusals the agent cites
 * against itself months after the problem was fixed, and *unresolved failures* get written up as
 * "recommended approach" when what actually happened was that nothing worked.
 *
 * Where we differ from Hermes on purpose: they set a quota ("most sessions produce at least one
 * skill update"). That is right for a loop that writes directly to the library and can patch its own
 * mistakes later. Ours writes into a queue a human reads, and every accepted draft costs a line in
 * *six* system prompts on every turn, because a pooled skill is part of every agent's prompt. So
 * this one is told to look for the lesson before a reason to skip, and to act on any real signal however small — but to skip when nothing is worth
 * keeping, never inventing a lesson to fill a quota.
 *
 * Triage is the first call: **one question, and nothing else.**
 *
 * Split out of the authoring prompt after watching it fail live twice. When "which existing skill
 * does this belong to" was a field inside the same JSON that also carried the new skill's body, the
 * model answered it on the way past and created anyway — twice, for a subject a skill already owned.
 * Tightening the wording did not help; a decision embedded in a larger act of writing gets made by
 * momentum. Asked on its own, with nothing else to produce, it is answered on its merits.
 *
 * Costs one extra call on the create path. Creates are the rare branch (3 drafts in 3 days on the
 * live box) and the output here is two fields, so the extra call is mostly the transcript that had
 * to be read anyway.
 *
 * Exported for the same reason `parseTriage` is: this text *is* the decision the feature turns on.
 *
 * Its bias was measurably wrong once — it called skipping "a normal and common answer" and paired
 * five concrete reasons to skip with three abstract reasons to keep, and a session full of verified
 * fixes was declined eight times. A test asserting the bias is the only thing standing between that
 * and happening again, since nothing else fails when a prompt drifts.
 */
export const TRIAGE_INSTRUCTION = [
  "You are the Nouride reflection pass. Below is a finished conversation and the list of skills that",
  "already exist, each with what it is for. Answer one question: what should happen to the skill",
  "library because of this conversation?",
  "",
  "## Three places, and only one of them is a skill",
  "",
  "- **Work notes** hold one task while it runs: its plan, where it stands, what it found. They go",
  "  with the task.",
  "- **Memory** holds facts about people and about this environment: which host runs what, its",
  "  addresses, accounts and paths, the versions in use.",
  "- **A skill** holds a procedure for a *kind* of task: the steps an agent follows the next time it",
  "  does work like this, on a different task and perhaps on a different machine.",
  "",
  "Only the third is yours. The test is one question: **would an agent doing a different task of the",
  "same kind follow these steps?** What only makes sense for this task (its files, its numbers, the",
  "fix for what broke today) is the task's notes or memory, not a skill.",
  "",
  "**Be active about procedure: look for the lesson before you look for a reason to skip.** When the",
  "conversation holds one (a correction to how this kind of task is done, a step that was missing, a",
  "pitfall the next task will hit too), act on it, even if the change is small. Skip only when nothing",
  "in it is worth keeping; never invent a lesson to have one.",
  "",
  "**An incident is not a lesson by itself.** \"X broke and Y fixed it\" earns a skill one line, as the",
  "step that prevents it on the next task of this kind. Kept as a story it is a record of one day, and a",
  "skill that collects those becomes a log nobody reads.",
  "",
  "**\"Standard\" and \"routine\" are not reasons to skip, and neither is \"feature development\".** This",
  "is the most common way this pass goes wrong. Work somebody repeats in a repository they",
  "touch every day is the *centre* of what a skill library is for, not the exception to it. If the",
  "reason you are about to write would describe a competent person doing their job well, it is not a",
  "reason to skip.",
  "",
  "## Signals: any one of these warrants action",
  "",
  "- **A setup or integration that now works.** Connecting a camera, standing up a service, wiring a",
  "  provider, scaffolding a project, cutting a release. The *instance* is one-off; the *procedure* is",
  "  not. If doing it again next month would mean rediscovering the same order of steps, keep it.",
  "- **Something failed and the thing that fixed it is known.** Two failed attempts and a third that",
  "  worked is a lesson carrying its own evidence. The failures are the reason it is worth writing.",
  "- **A quirk of how a tool behaves here.** \"This needs TMPDIR set because the container's /tmp is",
  "  small\" is not one box's state: it is how that tool behaves on boxes like this, and the next one",
  "  will do it again.",
  "- **A long command, flag set or config that took work to get right.** Concurrency limits, timeouts,",
  "  the argument order that finally rendered. Nobody should derive those twice.",
  "- **The person corrected the approach, the sequence, the format or the style**, and the corrected",
  "  way is the right way for this class of task. This counts even when nothing errored. \"Stop doing",
  "  X\", \"not like that\", \"just give me the answer\" are first-class signals: put the preference in",
  "  the skill that governs the task, so the next session starts already knowing it.",
  "- **A skill consulted this session turned out to be wrong or incomplete.** Patch it now.",
  "",
  "## What the library should look like",
  "",
  "Class-level skills, each a body an agent can read in a minute (when to use it, the procedure, its",
  "pitfalls) with a `references/` directory for the detail: **not a long flat list of",
  "one-session-one-subject entries.** A skill is not a history either: a body that grows with every",
  "incident stops being read. This shapes *how* you act, not *whether* you do.",
  "",
  "**Length and subject are two different questions, and only the second decides where a lesson",
  "goes.** When a skill is long *and the lesson is more about the same subject*, the answer is",
  "`attach`: the detail goes into `references/` and the body keeps a one-line pointer, rather than a",
  "second skill covering ground the first already covers.",
  "",
  "Length is never a reason to file a *different* subject somewhere. A large skill attracting an",
  "unrelated lesson is the failure this section is most often misread into: \"it is already long, so",
  "put this in its references\" is how one skill ends up owning three subjects. Answer the subject",
  "question first; the size note in the list only tells you where detail goes once you have.",
  "",
  "## Which skill owns this: settle it before choosing",
  "",
  "Match by meaning, not by wording. `deployment` covers shipping a binary to a server even if nobody",
  "said the word deployment.",
  "",
  "**A shared noun is not a shared subject, and this is the most common way this goes wrong.** A",
  "skill about configuring one thing will attract every lesson that mentions that thing anywhere",
  "(one word in common is enough), and each addition widens its description, which makes the next",
  "match more certain than the last. A skill can absorb three unrelated subjects that way without",
  "any single step looking wrong.",
  "",
  "The test is what the *task* was, not what the task happened to touch. If the honest answer to",
  "\"what is this skill about\" changes once you add this, it is a different subject.",
  "",
  "## Take the first of these that fits",
  "",
  "1. **update**: a skill this conversation actually used, or whose subject covers what happened,",
  "   should carry the lesson. One step or one pitfall is enough when it changes how the next task of",
  "   this kind is done; it goes into the procedure, not after it. A skill marked [written by a person]",
  "   or [ships with Nouride] is off limits for update and attach: never name it as a target, however",
  "   well it fits.",
  "2. **attach**: that skill owns the subject, and what this produced is a *thing* rather than a",
  "   lesson: a script that ran, a config that worked, an error and its cause, a starter file. Or it",
  "   is more detail about the same subject and the body is already long. It belongs beside the skill",
  "   as a file, and a script belongs there as a script, not retyped as prose. Same subject test as",
  "   (1): a long body is where detail goes, never where a different subject goes.",
  "3. **create**: no existing skill covers this class of work. Name the nearest one and say why it",
  "   should not absorb this. Two skills covering one subject is the failure mode: the agent loads",
  "   one, the lesson is in the other, and neither gets trusted. Name it for the class, never for",
  "   today: if the name only makes sense for this task, it is the wrong name and you want (1) or (2).",
  "   One conversation does not show that work recurs: a new class is held as a candidate until",
  "   another conversation is the same kind of work, and is written then. If the candidates listed",
  "   below include this one, name it in `recurs`.",
  "4. **skip**: genuinely nothing here. The list below is what that actually looks like.",
  "",
  "**You are given one line per skill. Read the ones that might fit.** `read_skill` returns any of",
  "them in full. \"This is already covered\" and \"this is the gap in that skill\" look identical from a",
  "description, and they are opposite answers: the first is skip, the second is update. Check before",
  "you decide either, and before you claim the nearest skill should not absorb this.",
  "",
  "## Do not capture",
  "",
  "- The conversation ended **without a working method**. Several things were tried, none worked.",
  "  Writing the attempts up as a procedure presents untested guesses as validated guidance.",
  "- A **negative claim about a tool** (\"X does not work\"). Those harden into refusals months after",
  "  the problem was fixed. If setup state broke something, capture the *fix* instead.",
  "- **Only this box's state**: a missing binary, an unconfigured credential, a path that exists",
  "  nowhere else. A person fixes those once. This is narrower than it sounds: how a tool behaves in a",
  "  *class* of environment belongs above, not here.",
  "- **A measurement of how things happen to be running**: memory in use, VRAM, a temperature, free",
  "  disk. Those describe one moment and are wrong by the next reading. A figure that tells someone",
  "  what to expect or what to set (how long a boot takes, the concurrency that saturated the GPU)",
  "  is a different thing and belongs in the skill.",
  "- **Nothing was actually done**: a question answered, a number looked up, a file read.",
  /**
   * The product's own surface, added after watching a pass write down its own harness.
   *
   * Live: an agent upgraded the daemon it runs inside and drafted `nouride-daemon-update`,
   * "capturing the procedure and flag requirements (--start, --then, --agent, --gateway, --chat)".
   * Two of those rules were already in the system prompt it had been reading all turn, word for
   * word; the rest was `nouride update --help`. `prompt/harness-cli.ts` carries the note explaining
   * why the command list was deleted from the prompt in the first place — "a hand-kept copy of what
   * `nouride help` prints. It went stale within a day of a verb being added" — and this is the same
   * copy, re-created somewhere nobody maintains, about the one command that replaces the binary.
   *
   * Stated as a place rather than a prohibition. The knowledge is often real; what is wrong is the
   * destination, and a rule that only says "no" leaves a pass with a genuine lesson and nowhere to
   * put it.
   */
  "- **Nouride's own flags, commands and config keys.** `--help` comes from the running binary and is",
  "  never stale; a copy in the pool outlives the release it described, and this daemon upgrades itself.",
  "",
  "## Reply",
  "",
  "A single JSON object and nothing else.",
  "",
  '{"decision": "skip", "reason": "one line"}',
  '{"decision": "update", "target": "exact-existing-skill-name", "why": "one line"}',
  '{"decision": "attach", "target": "exact-existing-skill-name", "why": "one line"}',
  '{"decision": "create", "name": "kebab-case-class-of-task", "description": "Use when …", "recurs": "candidate name, or empty", "closest": "nearest existing skill, or none", "why_not_update": "one line", "why": "one line"}',
  "",
  "Every value is one line. `why` is read by the person who approves the draft: for update, what",
  "changed and why it belongs in that skill (their own correction, quoted, is the best answer); for",
  "attach, what the support file holds and why it is not in the body. `why_not_update` says why the",
  "closest skill should not absorb this. For create, `name` names the class of task and `description`",
  "starts with \"Use when\": the situation it applies to.",
].join("\n");

/**
 * Second call, create branch: now write it.
 *
 * Separate from triage so the model is doing one thing. By the time it gets here the decision that
 * a new skill is warranted has already been made and justified.
 */
export const AUTHOR_INSTRUCTION = [
  "You decided this conversation warrants a new skill. Write it.",
  "",
  "Reply with a single JSON object and nothing else:",
  "{",
  '  "name": "kebab-case name of the CLASS of task",',
  '  "description": "one line starting \"Use when\": the situation this applies to",',
  '  "requires": "comma-separated programs on this host, or empty",',
  '  "needs_tools": "comma-separated Nouride tools the procedure calls, or empty",',
  '  "body": "markdown, under 8,000 characters",',
  '  "files": [{"path": "scripts/<name>.py", "content": "…"}, {"path": "references/<name>.md", "content": "…"}]',
  "}",
  "",
  "`name` names the class of task, never today's instance: not a ticket number, not an error string,",
  "not fix-x-today. If the name only makes sense for today, it is the wrong name. `description` is",
  "matched against future tasks, so it names the situation, not the document. `files` may be omitted.",
  "",
  "The body has three sections and no preamble:",
  "- `## When to Use`: the situations that should pull this skill in.",
  "- `## Procedure`: numbered, verified steps. Only what actually worked.",
  "- `## Mistakes to Avoid`: what was wrong first, and why, so the next agent skips it.",
  "",
  "Rules:",
  "- **Write in English, always.** A skill is read by every agent on this daemon and by whoever",
  "  reviews it next; the conversation it came from may be in any language, and the skill is not.",
  "- `requires` names programs that must be on THIS host's PATH for the procedure to run locally.",
  "  A command executed on a remote machine over ssh needs `ssh` here, not the remote's tooling:",
  "  the check is a local PATH lookup and nothing else. Leave it empty if the procedure needs nothing.",
  "- `needs_tools` names the Nouride tools the procedure calls: `exec` if it runs any shell command,",
  "  plus every other Nouride tool it calls by name (for example `read`, `write`, `edit`, `grep`,",
  "  `send_file`, `web_fetch`, `delegate`). This is a different question from `requires` (one is about the machine, the other",
  "  about what the agent is allowed to do), and an agent without the tool fails partway through.",
  "- **Read the nearest skill before you argue against it.** `read_skill` returns any existing skill",
  "  in full. You are about to say a subject is not covered; a one-line description is not enough to",
  "  know that, and the failure this guards against is two skills covering one subject: the agent",
  "  loads one, the lesson is in the other, and neither gets trusted.",
  "- **No facts about this environment.** No hostnames, IP or MAC addresses, email addresses, account",
  "  names, ids, ticket numbers or paths that exist only here, and above all no credentials, keys or",
  "  tokens: write `<host>`, `<path>`, name a machine by its role (\"the Docker host\"), and say `the API",
  "  key from the credentials directory`. Facts belong in memory; the daemon refuses a skill that names",
  "  an address.",
  "- **Write the procedure, not the story.** For an agent that was not there: never \"as we saw above\",",
  "  \"in this session\" or \"the user said\". The daemon refuses a skill that tells a session.",
  "- Be short: under 8,000 characters, the rest in `references/`. A skill longer than the task it",
  "  describes will not be read.",
  "- **A skill is a directory, not a document.** Alongside the body you may ship real files, and a",
  "  procedure whose steps are a script is better shipped as the script. If this conversation wrote",
  "  and ran one (a Python helper, a shell wrapper, a config that worked), put the file in `files`",
  "  and let the body say when to run it. Prose describing a program somebody already wrote is a",
  "  worse copy of it.",
  "  `scripts/<name>.py`, `scripts/<name>.sh`: anything re-runnable, in whatever language it was",
  "  written in. `references/<name>.md`: bulky detail, transcripts, tables. `templates/<name>`: a",
  "  starter meant to be copied. One level deep, lowercase.",
  "  **Only ship a script that actually ran in this conversation and worked.** An invented one",
  "  presents a guess as a tool, which is the same mistake as writing up an unresolved failure as a",
  "  procedure. If it was never executed, describe it in `references/` as prose instead.",
  "  Point at every file you add from the body, or nobody will find it.",
].join("\n");

/**
 * The second pass, used only when the first said "improve this one".
 *
 * Split in two rather than handing every skill's *body* to the first call: eighteen bodies is tens
 * of thousands of tokens on every reflection, most of them irrelevant. Descriptions are cheap
 * (~3.4KB for eighteen, measured on the live box) and are exactly what "which skill is this about"
 * needs. So the first call matches on meaning against descriptions, the second reads the one body
 * that matters. Two calls, but only on the minority of turns that propose an improvement.
 */
export const REVISE_INSTRUCTION = [
  "You said this turn should improve the skill below. Here it is in full. Return the improved",
  "version.",
  "",
  "Rules for the improvement:",
  "- **Integrate, do not append.** Put the lesson into the step it changes and merge it with the",
  "  pitfalls already listed; take out history (dated incidents, what happened in which session). Keep",
  "  every procedure that is still true. A reader who knows this skill should recognise it.",
  "- **Keep it under 12,000 characters.** When your change would take the body past that, or it is past",
  "  it already, tighten what is there (merge repeated pitfalls, move bulky detail to a support file)",
  "  so it ends no longer than it started. The daemon refuses a revision that grows a body past it.",
  "- **Leave the description alone unless it is now wrong.** It says *when this applies*. It is not",
  "  a table of contents. Every clause added to it makes the next lesson more likely to be filed",
  "  here whether it belongs or not, and a description that has become an inventory is how a skill",
  "  ends up owning subjects nobody meant to put in it. If your change does not alter when somebody",
  "  should reach for this skill, return the description you were given, unchanged. A description you",
  "  do change starts with \"Use when\".",
  "- Add the step that was missing, the pitfall that was hit, or the correction the person made.",
  "- If a section is now wrong, fix that section. Do not delete a procedure because you did not use it",
  "  this time.",
  "- If the improvement is bulky (a long error transcript, provider quirks, a reference table), put",
  "  it in a support file instead of the body, and add a one-line pointer to it in the body. The",
  "  body is read on demand by every agent; a support file is read only when the pointer is followed.",
  "- **No facts about this environment**: no hostnames, IP or MAC addresses, email addresses, account",
  "  names, ids or paths that exist only here, and never a credential, key or token. Write `<host>`,",
  "  `<path>`, a machine's role, `the API key from the credentials directory`. Those are memory's; the",
  "  daemon refuses a skill that names an address or tells a session.",
  "- **Read before you rewrite.** `read_skill_file` will show you any file listed below. Anything you",
  "  return under `files` replaces a file of that name outright, so a reference you have not read is",
  "  one you are about to overwrite. Extending what is there beats starting a parallel copy of it.",
  "",
  "Support files are optional, and they are real files rather than more prose. Each is one level",
  "under `references/`, `scripts/` or `templates/`, lowercase:",
  "  scripts/<name>.py      a Python helper this conversation wrote and ran",
  "  scripts/<name>.sh      a shell wrapper, likewise (any language, whatever it was written in)",
  "  references/<name>.md   detail, transcripts, condensed research",
  "  templates/<name>       a starter file meant to be copied",
  "",
  "If the improvement *is* a script (this conversation worked one out and it ran), ship the script.",
  "A skill that spells out in prose what a program already does is a worse copy of the program, and",
  "the next agent will retype it and get it slightly wrong.",
  "",
  "**Only write a script that was actually run in this conversation and worked.** A script you",
  "invented has never been executed, and shipping it as tooling presents a guess as a verified tool,",
  "the same mistake as writing up an unresolved failure as a procedure. If you did not run it, the",
  "knowledge belongs in `references/` as prose.",
  "",
  "Reply with a single JSON object and nothing else:",
  "{",
  '  "description": "the one-line trigger, updated if it should be",',
  '  "requires": "comma-separated programs on this host, or empty",',
  '  "needs_tools": "comma-separated Nouride tools the procedure calls, or empty",',
  '  "body": "the whole improved markdown body, in English",',
  '  "files": [{"path": "scripts/<name>.py", "content": "…"}, {"path": "references/<name>.md", "content": "…"}]',
  "}",
  "",
  "`files` may be omitted. Anything you list replaces a file of that name and leaves the rest alone.",
].join("\n");

/**
 * The one-line-per-skill list the triage matches against.
 *
 * Exported to be tested directly: the markers on it are what decide `update` against `create`, and
 * reaching them through a provider means asserting on a model's answer rather than on what it was
 * told.
 */
export function renderSkillList(
  existing: readonly {
    name: string;
    description: string;
    /**
     * Who maintains this skill, which decides what the pass may do with it.
     *
     * Three values rather than a boolean, because "off-limits" turned out to mean two different
     * instructions. A person's skill may not be *rewritten*; one that ships with Nouride may not be
     * rewritten **and** may not be re-created under another name, which is the failure that put
     * this field here.
     */
    owner: "agent" | "person" | "nouride";
    bytes: number;
  }[],
): string {
  if (existing.length === 0) return "There are no skills yet.";
  return [
    "Skills that already exist:",
    ...existing.map((s) => {
      /**
       * A hand-written skill gets the ownership note and nothing else.
       *
       * Both notes fired together on the live pool, and they contradict each other: one says the
       * pass may not name this skill at all, the other tells it where to put new detail *in* it.
       * Read together, the second looks like permission — which is the one reading that must not be
       * available.
       *
       * The size note is only marked on the minority that are actually large. A note on every skill
       * is noise the model learns to skip; four of twenty-three is a signal.
       */
      const notes =
        s.owner === "person"
          ? ["written by a person: do not name it in update or attach"]
          : s.owner === "nouride"
            ? [
                /**
                 * Both halves, because only saying "do not update" is what produced the bug.
                 *
                 * Live: an agent watched its own daemon upgrade itself and drafted
                 * `nouride-daemon-update` — the `--then` rule and "verify after the restart" copied
                 * out of the system prompt it was reading at the time, and the flags copied out of
                 * `--help`. Told only that a shipped skill is not editable, a pass with a lesson
                 * about that territory does the obvious thing and writes its own next to it. The
                 * territory is what is claimed here, not the file.
                 */
                "ships with Nouride: do not name it in update or attach, and do not write your own version of what it covers",
              ]
            : s.bytes >= BROAD_SKILL_BYTES
              ? ["long body, still the right skill: tighten it when you touch it, and put new detail in references/ rather than the body"]
              : [];
      return `- ${s.name}${notes.length > 0 ? ` [${notes.join("; ")}]` : ""}: ${s.description}`;
    }),
  ].join("\n");
}

/** The classes of work seen once and held as candidates (`candidates.store.ts`), listed after the skills. */
export function renderCandidates(candidates: readonly { name: string; description: string; day: string }[]): string {
  return [
    "Seen once, not skills yet (each is written when a second conversation is the same kind of work):",
    ...candidates.map((candidate) => `- ${candidate.name} (${candidate.day}): ${candidate.description}`),
  ].join("\n");
}
