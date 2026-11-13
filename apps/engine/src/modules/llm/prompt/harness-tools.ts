/**
 * The TOOLS section: what this agent may call, what is gated, and the two rules about stopping.
 */

import { DASHBOARD_LINKS } from "./harness-limits.ts";
import type { HarnessView } from "./types.ts";
import { BALANCED_LIST, EVERY_LEVEL_ASKS, renderExecPolicy } from "./exec-policy.ts";
import { installLadder } from "./harness-skills.ts";
import { toolchainLines } from "./harness-toolchain.ts";
import { renderDelegate } from "./harness-delegate.ts";
import { renderWork } from "./harness-work.ts";
import { renderTiers } from "./harness-tiers.ts";
import { MISSION_DRAFT, WHO_SIGNS } from "@/modules/tools/builtins/mission.ts";


/**
 * The tools with a batch shape this agent actually holds, in one line.
 *
 * Built from the toolset rather than written out, so a tool that gains a list parameter is named here
 * the day it does — `web_fetch` gained `urls` after this line was written for `read` and `grep`, and a
 * fixed sentence would have kept telling the model about two of three.
 */
function listShapedTools(toolNames: string[]): string[] {
  const shapes = [
    toolNames.includes("read") && "`read` accepts `paths` for up to ten files",
    toolNames.includes("grep") && "`grep` accepts `patterns` for up to five searches in one pass over the files",
    toolNames.includes("web_search") && "`web_search` accepts `queries` for up to three searches at the same time",
    toolNames.includes("web_fetch") && "`web_fetch` accepts `urls` for up to five pages, fetched at the same time",
  ].filter((shape): shape is string => typeof shape === "string");
  if (shapes.length === 0) return [];
  const which = shapes.length === 1 ? "One of these takes" : `${["", "", "Two", "Three", "Four"][shapes.length]} of these take`;
  return [
    `- ${which} a list, which is cheaper still than several calls: ${joinClauses(shapes)}. Reach for ${shapes.length === 1 ? "it" : "those"} before you reach for a second call.`,
  ];
}

function joinClauses(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

export function renderTools(view: HarnessView): string[] {
  const { ctx, toolNames, gated, free } = view;
  const { harness } = ctx;
  const lines: string[] = [];

  lines.push("TOOLS");
  if (toolNames.length === 0) {
    lines.push("- You have none. Say so rather than describing what you would run.");
  } else {
    lines.push(
      `- Call them; never write out a result you did not get back. Ready to use: ${free.join(", ") || "none"}.`,
      /**
       * Ask for several things in one message.
       *
       * The mechanics have always worked — both wire formats let a model emit a list of tool calls,
       * and the executor loops it — but nothing here ever said so, and `delegate` is the proof of what
       * that costs: enabled for six agents, described only by its own schema, called zero times in
       * 2,225 executions until a line was written for it.
       *
       * What the line buys is not wall-clock, it is *round trips*. Each one resends the whole
       * conversation, so four separate reads pay for the context four times; four reads in one message
       * pay once. On an install where nothing is cached that is the difference between linear and
       * quadratic growth in an agent loop. Parallel execution of the read-only ones is the smaller
       * half, and the harness does that on its own — see
       * `apps/engine/src/modules/llm/executor/tool-batching.ts`.
       *
       * Promoted to the top of the block, and given the measurement.
       *
       * It used to sit fifteen bullets down, after every tool-specific note, and the daemon's own
       * numbers said it was not landing: across finished turns the median was **1.00 tool calls per
       * model round trip**, and only a third of turns batched anything at all. The one turn that put
       * five reads in a single message cost 63k input tokens where the same five, one at a time, cost
       * 151k and took 2.4x as long.
       *
       * So the cost is stated as a fact about this conversation rather than as advice. A model that is
       * told "four calls in one message cost a quarter of four messages" has a reason; a model told
       * "batch your calls" has a preference it can weigh against its own habit — and it did.
       */
      "- **Ask for everything you need in ONE message.** Every reply you make re-sends this entire conversation to the model, so four separate tool calls pay for the whole context four times and four calls in one reply pay once. When the next calls do not depend on each other (files to read, greps to run, pages to fetch, commands whose output you want side by side), put them all in the same reply. The read-only ones then also run at the same time.",
      "- Before you call a tool a second time in a row, ask whether the second call could have gone in the first message. If it could, that round trip was paid for nothing.",
      /**
       * The two tools with a batch shape, named because a schema is not read the way a rule is.
       *
       * `read`'s `paths` and `grep`'s `patterns` are both in the schema with descriptions that say to
       * prefer them, and that was not enough for the batching rule above either — the measured median
       * stayed at 1.00 calls per round trip while the instruction sat fifteen bullets down. Naming the
       * parameters here costs two lines and turns "batch your calls" into something with an argument.
       */
      ...listShapedTools(toolNames),
      /**
       * The other half of the rule above: steps that *do* depend on each other.
       *
       * The batching rule only covers independent calls, so a branch → commit → push still went out as
       * three round trips, each re-sending the whole conversation. A chain in one `exec` stops at the
       * first failure and returns its error, which is everything the next turn needs.
       */
      ...(toolNames.includes("exec")
        ? [
            "- **Whenever you already know the next commands, run them in ONE `exec`.** This is a rule about every shell task, not a list of approved workflows: setup, installs, builds, tests, git, file moves, deploys, ssh, docker, data wrangling, anything. Chain steps that depend on each other with `&&` (it stops at the first failure and you get that error back), pipe with `|`, or write a multi-line script. Examples only to show the shape: `mkdir -p out && cp -r src/* out/ && ls out`, `docker build -t app . && docker run --rm app npm test`, `ssh host 'systemctl restart app && journalctl -u app -n 50'`. On another machine, send the whole sequence through ONE `ssh` (`ssh host 'bash -s' <<'EOF'` … `EOF`), not one `ssh` per command. Only split across turns when you genuinely need to read one output before deciding the next command. Independent commands go as separate `exec` calls in the same message.",
          ]
        : []),
      /**
       * Which surface to use when two of them can do the job.
       *
       * Only worth saying to an agent that holds both, which is why it is gated. Measured on a live
       * box over 38 hours: 13% of `exec` calls were a shell spelling of a tool the agent already had
       * — `cat` for `read`, `head -n 60` for `read` with a limit, `grep -i` for `grep`. Small, but
       * nothing anywhere said which to prefer, so it was a habit the prompt permitted rather than one
       * it ruled out.
       *
       * Two costs, both real and both checkable — no invented token figure. The batching one is the
       * same argument the rule above makes; the permanence one is why `--stdin` exists.
       */
      ...(toolNames.includes("exec") && (toolNames.includes("read") || toolNames.includes("grep"))
        ? [
            "- When a tool and a shell command do the same thing, use the tool. `read` over `cat` and `head`, the `grep` tool over shell `grep`, `glob` over `ls` and `find`, `edit` over `sed -i`. Two reasons that are not taste: a tool call batches (one `read` takes ten paths where ten `cat`s are ten round trips, each re-sending this whole conversation), and a command's arguments are recorded permanently in the exec grant, the audit log and this daemon's log table; a tool call's arguments are not. Reach for `exec` when there is no tool for it: running a script, a binary, git, ssh, a package manager.",
          ]
        : []),
    );
    // Worded per approval level: at `trusted` and `balanced` the gate is partly or wholly off, and a line
    // saying "these pause for a human" beside "nothing will ask" left the model to pick one.
    const level = harness.approvals ?? "careful";
    if (gated.length > 0) {
      lines.push(
        level === "trusted"
          ? `- Normally gated, but at this conversation's approval level they run without asking: ${gated.join(", ")}.`
          : level === "balanced"
            ? `- Normally gated: ${gated.join(", ")}. At this conversation's approval level they run without asking, except the calls listed below that still stop for a human${harness.approvalAvailable ? "" : ". No approver is available in this build, so those WILL be refused"}.`
            : harness.approvalAvailable
              ? `- These pause for a human to approve, which may take a while or be denied: ${gated.join(", ")}.`
              : `- These need human approval, and no approver is available in this build, so they WILL be refused: ${gated.join(", ")}. Do not promise to run them: say you cannot and offer an alternative.`,
      );
    }
    if (harness.execPolicy && toolNames.includes("exec")) {
      lines.push(...renderExecPolicy(harness.execPolicy, undefined, level));
    }
    /**
     * What will actually be asked, which the policy above does not answer on its own.
     *
     * The gate says what it wants to ask; the approval level says what happens to that want. Only the two
     * loosened levels are stated — at `careful` the exec-policy lines above already describe the behaviour,
     * and a line saying "you will be asked as configured" is prompt budget spent on a tautology.
     */
    if (level === "balanced") {
      lines.push(`- Most calls run without asking anybody. What still stops for a human, every time: ${BALANCED_LIST}. Plan on those pausing.`);
    }
    if (level === "trusted") {
      lines.push(
        `- **Almost nothing will ask**: only ${EVERY_LEVEL_ASKS}. Every other gate is off for this conversation, including deletes, config changes and stopping this daemon. Nothing downstream will stop a mistake, so the care that a prompt used to provide is now yours: re-read a destructive command before running it, prefer the narrow version of it, and say what you are about to do before you do it rather than after.`,
      );
    }
    lines.push(
      "- A tool result marked as an error is information, not a dead end. Read it and adapt; the message usually says what to do instead.",
    // Said because it has happened: asked for a current price with no search tool available, the model
    // wrote `python3 -c "import urllib.request …"` and ran it through `exec`. It now has `web_search`,
    // but the habit is worth naming — a shell is always *available*, which makes it the thing a model
    // reaches for when the right tool is not obvious.
    ...(toolNames.includes("web_search") && toolNames.includes("exec")
      ? [
          "- To find something on the web, use `web_search` and then `web_fetch`. Do not write a script to scrape a search engine: those two tools already do it, without an approval and without a parser you have to maintain.",
        ]
      : []),
    /**
     * Several changes to one file, as one call.
     *
     * Measured over two weeks on the live box: 162 `edit` calls, one `multi_edit` (a probe), and 62
     * of those edits were the second-to-seventh in a row on the same file. See `executor/nudges.ts`,
     * which catches the habit on the result when this line did not prevent it.
     */
    ...(toolNames.includes("multi_edit")
      ? [
          "- **More than one change to a file goes in ONE `multi_edit`, never several `edit` calls.** Decide every change to the file first, then make them together: one round trip instead of one per change, one approval instead of several, and the file is never left half-changed, because nothing is written unless every change applies. `edit` is for a single change.",
        ]
      : []),
    /**
     * Web research in as few round trips as it can take, stated as a rule rather than a preference.
     *
     * The shape a model falls into is one page per reply: search, fetch the top hit, read it, fetch the
     * next. Every step re-sends the whole conversation and waits on a network it could have waited on
     * once. `urls` exists so the sources picked from one search are one call; this says so where the
     * decision is made, because the schema alone had not moved the batching rate for `read` either.
     */
    ...(toolNames.includes("web_fetch")
      ? [
          "- **Web research goes in batches, never one page per reply.** Whenever you want more than one page, fetch them in ONE `web_fetch` with `urls`. They are fetched at the same time. After a search, choose every source worth reading from the results and fetch them all together; do not read the first, then the second, then the third." +
            (toolNames.includes("web_search")
              ? " The same for searching: the angles you already know you want go in ONE `web_search` with `queries`, not one search per reply."
              : "") +
            " Another round of fetching is only for what the last round revealed (a link inside a page you just read), not for the next item on a list you already had.",
        ]
      : []),
    /**
     * The one rule in this list that is not about *choosing* a tool.
     *
     * Live, on Telegram: asked about "Hermes", the agent wrote nine paragraphs comparing model
     * weights, datasets, fine-tunes and open-source ethos — a confident, well-organized essay about
     * the wrong Hermes, because the question was about an agent harness. Zero tool calls; the whole
     * thing came out of the model. The correction was "bukan hermes model, makanya lu riset dulu
     * sebelum ngomong", and the next turn — the first one that used its tools — took three steps and
     * got it right.
     *
     * `web_search` was in that agent's toolset the entire time. Nothing had ever asked it to look.
     *
     * This is not already covered by the first line of the section. "Never write out a result you did
     * not get back" is about inventing what a tool said, which is a different failure: it guards the
     * answers a tool *gave*, not the ones no tool was asked for. Every other entry here corrects a
     * tool choice and fails visibly when ignored — `exec` waits out a timeout, a cron entry does not
     * appear. This one corrects a situation the model cannot feel it is in, because remembering and
     * inventing feel identical from the inside.
     *
     * Gated on the tool, like everything else in this file. An agent with no search cannot obey it,
     * and a rule it cannot follow is a rule it learns to skip.
     *
     * **The second line is not softening the first.** Without it the rule reads as "search before
     * every sentence", which is its own failure: an agent that goes to the web before answering what
     * time it is, or a question about this conversation, is slower to be useful — and an operator who
     * finds that annoying turns the whole thing off. Marking the unverified part is what makes the
     * cheap path honest rather than forbidden, and it is the half a person can actually act on: an
     * unmarked guess is indistinguishable from a checked fact, and that is the entire cost of being
     * wrong.
     */
    ...(toolNames.includes("web_search")
      ? [
          "- A claim about the world outside this machine (what a product is, who made it, a version, a price, what changed recently, whether a thing exists at all) gets `web_search` before you assert it. Your training has a cut-off and does not tell you where it ends, so a name you recognise may be something else now, and remembering feels exactly like knowing.",
          "- Answer from memory only what does not change: a definition, arithmetic, a settled concept. Anything new, recent, or that you are not sure of gets the search. Where you still answer without one, say which part you did not verify, in the same message: an unmarked guess cannot be told from something you looked up.",
        ]
      : []),
    /**
     * The one line here whose failure leaves no error to learn from.
     *
     * Every other entry in this list corrects a *tool* choice, and a wrong tool at least fails
     * visibly — `exec` waits out a timeout, a crontab entry does not appear in `nouride cron`. This one
     * corrects a *situation* the model does not recognize it is in. Asked to write a scraper it plans
     * fetch → read → write, calls `web_fetch` because it wants to see the page, and gets back a
     * Markdown rendering that reads like a complete page. The class and id attributes are gone and
     * nothing in the output says so — so the selectors it writes next are guesses it has no way to
     * know are guesses.
     *
     * The `<head>` half of this line is narrower than it was. The Markdown now opens with the page
     * metadata as frontmatter, so the questions that used to force a second fetch — who wrote it,
     * when, what is the canonical URL, what is the card image — are answered where the model is
     * already looking. What is left is the long tail: an arbitrary `<meta>` name, a `<link rel>`,
     * the JSON inside a `<script>`. Still worth a clause, no longer worth the sentence.
     *
     * Which is why the parameter being in the schema is not enough, and the argument that it was is
     * the one that got this line left out when `format` was added in the first place. A schema answers "what can I
     * pass"; it does not fire when the model never asked the question. The trigger has to be the task
     * shape — writing a parser, reading a meta tag — the same way every line above it is.
     */
    ...(toolNames.includes("web_fetch")
      ? [
          '- Before you write a scraper or a parser for a page, fetch it with `format: "html"`. The default Markdown has already thrown away every class and id attribute, and what is left reads like the complete page, so nothing in it will tell you that the selector you are about to write is a guess. Its frontmatter already answers the ordinary `<head>` questions (who wrote this, when, what is the canonical URL), so re-fetch only for a tag it does not list.',
        ]
      : []),
    // Who does the work: here, a helper, another agent or a mission, by whose and how long (`harness-work.ts`, 0.8.17).
    ...renderWork(view),
    // `delegate`, in the foreground and — where this agent may — the background: `harness-delegate.ts`.
    ...renderDelegate(view),
    // Which model the work they start runs on, and what each costs against the others: `harness-tiers.ts`.
    ...renderTiers(view),
    // Said because a long turn eats the model's own account of what it set out to do: history is
    // trimmed oldest-first, and the plan is the oldest thing in it. `plan` is shown back in full
    // on every call, which is the entire reason it lives outside the conversation.
    ...(toolNames.includes("plan")
      ? [
          "- Work with more than a couple of steps: write the steps into `plan` first and mark each one done as you go. The list is rendered back to you on every call, so step four survives a long turn. Your own earlier messages are the first thing dropped when the context fills.",
        ]
      : []),
    // 0.7.26: the work in a file of the agent's own, because the history is what compaction, the rollover and `/new`
    // take — and the four-hour audit that lost its place had nothing else to fall back on.
    ...(toolNames.includes("notes")
      ? [
          "- Long work (more than one turn, or anything you wait on a person for) keeps its place in your work notes (`notes`), shown to you at the end of every request: the goal, what is done, what is next, the rules the person set and the facts you found. Write them when the work starts and as it moves; your plan is kept with its task there while steps are left. When the steps change something the person cares about (files on their machine, messages sent), send them the plan and ask once before the first step, rather than at every step.",
        ]
      : []),
    // How a mission starts, once "Who does the work" (`harness-work.ts`) has said when: a draft the person starts, and
    // who signs it off (0.8.11), for every chat turn that can start one.
    ...(harness.startsMissions
      ? [
          `- With \`mission\`: action "start" drafts it (a goal, a brief and checks that prove it done); "edit" changes the draft until the person starts it. ${MISSION_DRAFT} ${WHO_SIGNS}`,
        ]
      : []),
    /**
     * A missing binary, which is the most common way a correct plan fails.
     *
     * Watched twice on the live box, on the same file: `pdftotext` is not installed there, so the
     * first attempt returned `Executable not found in $PATH` — and both times the agent's next move
     * was to write a `python3 -c` parser from memory. It worked both times, which is why it looked
     * fine. What the operator never got was the sentence that would have fixed it permanently:
     * *poppler is not installed, here is the line.*
     *
     * The one-line install is worth more than the workaround: it is reviewable, it is reusable, and it
     * is the operator's decision to make about their own machine. And the workaround is the part
     * nobody reads — a hand-written parser, unreviewed, on somebody's document.
     *
     * The ladder is shared with SKILLS (`installLadder`) so the two cannot drift. There is no
     * "if they told you to install, install" escape hatch any more: the ladder already says to
     * install, and the approval gate is where a person says no.
     */
    ...(toolNames.includes("exec")
      ? [
          ...toolchainLines(harness.binDir, { ...(harness.ownHome ? { home: harness.ownHome } : {}), ...(harness.sharedBinDir ? { sharedBin: harness.sharedBinDir } : {}) }),
          "- `Executable not found in $PATH` is not a dead end, and not a reason to improvise a" +
            ` replacement. Install what is missing, in this order: ${installLadder(harness.binDir, { approvals: harness.approvals, ownHome: harness.ownHome, sharedBin: harness.sharedBinDir, sharesTools: harness.sharesTools })}` +
            " A parser or script you wrote from memory instead is the part nobody can review.",
        ]
      : []),
    // `exec` is the habit and `session` is the exception, so the exception has to be named. A command
    // that stops at a prompt gives `exec` nothing to do but wait for its timeout, and the model reads
    // the empty result as the command having failed rather than as it still asking.
    ...(toolNames.includes("session") && toolNames.includes("exec")
      ? [
          "- A program that stops and asks (a password, an ssh host-key confirmation, a REPL, an installer with a prompt) needs `session`, not `exec`. `exec` has no way to answer it, so it waits out the timeout and comes back with nothing. One command and one answer stays with `exec`.",
        ]
      : []),
    ...(toolNames.some((name) => name === "work" || name === "mission" || name === "schedule") ? [`- ${DASHBOARD_LINKS}`] : []),
    ...(toolNames.includes("send_file")
      ? [
          "- Anything longer than a screen that the person actually wants (a log, a report, a diff, an image, an archive) goes out with `send_file` as a real attachment. Pasted into the reply it gets split across messages, cannot be opened in anything, and costs you the room to think.",
        ]
      : []),
    // Found live: asked to post into a WhatsApp group, an agent read the daemon's database with python for the chat's id
    // and scheduled a job to post it — and the group's conversation never knew it had been said (0.7.23).
    ...(toolNames.includes("send_message")
      ? [
          "- Asked to tell somebody something, or to post into another chat (a person's one-to-one, a group): `send_message`. `to` is a person's key or name, a group's name, or a chat's address. With no `to` it lists the chats you can reach and sends nothing: never make up a `to` to see them. For a person with more than one chat, the answer lists theirs. Never read the daemon's database or schedule a job to find or reach a chat, or to check that a message went.",
        ]
      : []),
    ...(toolNames.includes("session_status")
      ? [
          "- Asked which model you are running, which chat this is, or how full your context is: call `session_status`. Do not answer from what you assume about yourself: an operator can change your model between turns and nothing tells you.",
        ]
      : []),
      /**
       * Both limits, because the model was only ever told about one of them.
       *
       * The round-trip cap has a rescue — reach it and you are asked to summarize. The clock had
       * none and was invisible, so a turn that spent its budget waiting rather than working hit it
       * without warning and the person got a harness message instead of an answer. The clock now
       * has the same rescue; this line is what lets the model avoid needing it.
       */
      `- At most ${harness.maxToolIterations} tool round-trips and ${Math.round(harness.maxTurnDurationMs / 1000)} seconds of wall clock per reply. Past either, tools are withdrawn and you are asked to summarize what you did and what is left, so do the important call first and put anything slower than that in a background job.`,
      // Steering (`pipeline/steering.ts`): without this, a message arriving mid-turn reads like a second, unrelated question.
      "- A message the person sends while you work is put in front of you before your next step, marked as sent while you were working. Read it and adjust: it may add to, change or stop what you are doing. If it asks you something, answer it in your reply.",
      /**
       * The round-trip cap is configurable and the model was the last to know.
       *
       * It is told the number every turn and had no way to tell that the number was a setting, so
       * hitting it read as a wall rather than as a dial — and the one thing an agent can do about a
       * wall is apologize. Naming the command turns "I ran out of steps" into a decision somebody can
       * make. The cost clause is not decoration: this is the one setting on the daemon that
       * multiplies a bill rather than changing a behaviour, and the effect is invisible until an
       * invoice arrives.
       */
      ...(toolNames.includes("nouride")
        ? [
            `- That round-trip cap is a setting, not a wall: \`nouride tool-budget --agent ${ctx.agent.config.id} <n>\` sets your own for good, and \`follow\` in place of the number puts you back on the daemon default. Raising it costs real money (every round-trip resends the whole conversation), so change it only when a task genuinely needs the room, say so when you do, and never raise it just to avoid summarizing.`,
          ]
        : []),
      // A helper has nobody to answer a question, so the stop-and-ask rule would strand it.
      harness.helper
        ? "- Nobody can answer a question from you: finish the job with what you were given, or say exactly what blocked it."
        : "- When you offer the user a choice, suggest an optional action, or ask whether to proceed: STOP. Do not execute it in the same reply. Your text is the last thing in that turn; the next tool call is the next turn, after they answer. Doing both at once says \"shall I?\" while already having done it.",
    );
  }

  return lines;
}
