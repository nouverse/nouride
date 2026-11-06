/**
 * `mission` — the agent's side of missions (MISSIONS §10): one tool, its `action` deciding which fields count.
 *
 * Two shapes, handed per turn (`ToolsetDeps.missionTool`). In a chat it offers `start` and `edit`: the agent decides
 * when work is mission-sized and drafts it, and the person starts it (0.8.11, `missions/drafts.ts`) — nobody has to type
 * `/mission`. Inside a mission's turn it adds what the mission says about itself: `done`, `ask`, `fail` — each ends the
 * turn there, and is acted on then.
 */

import { resolveWithin, statFile } from "@nouride/runtime";
import type { Tool, ToolContext, ToolResult } from "@nouride/shared";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import type { LinkFor } from "@/modules/web/links.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import { isMissionChat } from "@/modules/missions/gateway.ts";
import { isDraft, signedOffBy, type DraftChange } from "@/modules/missions/drafts.ts";
import type { Missions } from "@/modules/missions/missions.ts";
import type { StartRequest } from "@/modules/missions/start.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { doneWhen, shortId } from "@/modules/missions/page.ts";

/**
 * How joint work is shaped (0.8.7), in the start's description: one owner. Two missions on one piece of work each merged
 * their half, and nobody owned the whole.
 */
const ONE_OWNER =
  "Related pieces of work go in one parent mission, with isolated helpers or sub-missions; the parent merges them.";

/**
 * What a mission is for, the words that carry the rule (asserted by a test), in the tool's description, the harness's
 * "Who does the work" (`harness-work.ts`) and a coding CLI's instructions (`external-agents/instruction.ts`).
 *
 * 0.8.11 dropped minutes ("more than about ten minutes" was a guess made before the work showed its size) for examples,
 * and "many steps or items" among them drafted missions for work of ten minutes, which a helper in the background does
 * without a tap. 0.8.17 (the owner, 2026-11-04): more than about an hour, the hour a reply and a background helper have,
 * so work that may run past it is the one kind that cannot finish there; and what a mission gives, said: it keeps going
 * on its own and proves itself done.
 */
export const MISSION_IS_FOR =
  "Long work, more than about an hour, that goes on with little from the person goes to a mission: long development, a " +
  "deep analysis, a long scan or sweep, research across many sources, a migration, anything that waits on CI or a long " +
  "command, or work that should go on while the person is away. A mission keeps this chat free, survives restarts, keeps " +
  "going on its own (it works around what fails and proves itself done with checks) and is signed off.";

/** How one starts from a chat: a draft the person starts (RFC MISSION_DRAFTS §2.7), at once only on their word. */
export const MISSION_DRAFT =
  "From a chat, `mission` makes a draft the person starts; say what it will do and how it will be judged done. Start it " +
  "at once only when the person asked for that, with their words in `said`. What other harnesses call `/goal` is a mission here.";

/** The whole rule, where it is read alone: the tool's description and a coding CLI's instructions. */
export const WHEN_TO_START =
  `${MISSION_IS_FOR} Shorter work is not a mission's: a few minutes is done here; longer, it goes to a helper or another ` +
  `agent in the background. ${MISSION_DRAFT}`;

/**
 * Who signs a draft's result off, chosen by who is there (§2.6): a person following the work reads it sooner than a
 * reviewer's ten minutes a pass. Both wrong guesses are harmless — gone, it waits at Accept; there, the reviewer runs.
 * Said where the rule is read — the harness's TOOLS and a coding CLI's instructions — as well as here: in the
 * description alone, Nouva (live, 2026-10-31) drafted with the reviewer for a person who had just asked in the chat. And
 * said by the fields it is chosen with: `no_review` read "Skip the reviewer: the checks are the whole answer", which no
 * check of a translation is, so Nouva, with the rule in front of it in both places, still drafted with the reviewer.
 */
export const WHO_SIGNS =
  "Who signs it off: the person in this chat following the work gets checks, then `accept`, with `no_review`; the person " +
  "away or leaving (\"do it, I'm off to sleep\") gets checks and the reviewer.";

/**
 * What starts a mission, as the model reads it. A worktree is for code in a git repository (0.8.11): asked to audit a
 * spreadsheet, Nouva (live, 2026-10-31) ran `git init` in the folder holding it a minute before starting — the checks
 * said "prove an artifact here: a commit is on a local branch" — and the mission then worked on a branch of a copy,
 * committed the file there to satisfy its page, and told a person on WhatsApp the branch's name. A folder git does not
 * track gets no branch, and needs none.
 */
const START_FIELDS = {
  goal: { type: "string", description: "What must be true when it is done, in English, and whole: each turn starts from it, not from this conversation. A long one points at a brief file by its absolute path." },
  checks: {
    type: "array",
    items: { type: "string" },
    description:
      "Read-only commands that exit 0 only when it is really done: read the result back, count, test. They run in the mission's folder, with nobody to ask and none of your credentials. " +
      "Prove what the work leaves (the file holds what it should, or in a repository a commit on its branch), never outside state that can change, such as \"the PR is open\".",
  },
  review: { type: "string", description: "What a fresh reviewer should verify, in English. Default: the goal." },
  no_review: { type: "boolean", description: "No reviewer: the person following the work in this chat accepts it (`accept`), or the checks are the whole answer." },
  accept: { type: "boolean", description: "The person accepts after the checks pass: the sign-off when they follow the work in this chat." },
  agent: { type: "string", description: "Another agent to do it." },
  workdir: { type: "string", description: "Absolute path of an existing folder. Code in a git repository gets a worktree on its own branch; a person's documents are worked on where they are. Never make a repository for a mission." },
  branch: { type: "string", description: "Its worktree's new branch: code in a git `workdir` only. Default: mission/<id>." },
} as const;

/** A chat's own fields (0.8.11): a draft's brief and how it starts at once; `edit`'s id. */
const CHAT_FIELDS = {
  brief: { type: "string", description: "start, edit: the mission's brief, written to BRIEF.md in its folder (what the work is, why, what to read, what done means), in English. Each turn names it. Change it later with `edit` or your file tools." },
  now: { type: "boolean", description: "start: run at once, no draft, only when the person asked for that; needs `said`." },
  said: { type: "string", description: "start with `now`: the person's own words asking for it to run now, quoted as they wrote them." },
  id: { type: "string", description: "edit: your draft's id." },
} as const;

function ok(content: string): ToolResult {
  return { content, isError: false };
}

function refused(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * A claim ends the turn at once, its words the turn's reply (`ToolControl` "end"). Told "end your turn now", a model on
 * the live box went on for 30 more calls — re-claiming, reading the mission back, reading the logs — and a two-line
 * mission cost 1.3M tokens. What it is acted on with is the next turn's page, so nothing after the claim is wanted.
 */
function claimed(content: string, reply: string): ToolResult {
  return { content, isError: false, metadata: { control: { finishTurn: "end", note: "mission_claim", reply } } };
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** What `start` asks for, from the call — who it runs as is the caller's to add. */
function startFields(args: Record<string, unknown>, ctx: ToolContext): Omit<StartRequest, "startedBy" | "gatewayId" | "chatId"> {
  const checks = strings(args.checks);
  const workdir = text(args.workdir);
  const branch = text(args.branch);
  const review = args.no_review === true ? false : text(args.review) || undefined;
  return {
    agentId: text(args.agent) || ctx.agentId,
    goal: text(args.goal),
    ...(checks ? { checks } : {}),
    ...(review !== undefined ? { review } : {}),
    ...(args.accept === true ? { accept: true } : {}),
    ...(workdir ? { workdir } : {}),
    ...(branch ? { branch } : {}),
    byAgent: ctx.agentId,
    ...(ctx.untrustedRead && ctx.untrustedRead.length > 0 ? { untrusted: true } : {}),
  };
}

/** The agent's own draft, changed before it starts (§2.3): its fields, and its brief written again. */
async function editOwn(missions: Missions, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const id = text(args.id);
  const mission = id ? missions.find(id) : null;
  if (!mission || (mission.byAgent ?? mission.agentId) !== ctx.agentId) return refused(id ? `No draft ${id} of yours.` : "Name your draft: `id`.");
  const checks = strings(args.checks);
  const change: DraftChange = {
    ...(typeof args.goal === "string" ? { goal: args.goal } : {}),
    ...(checks ? { checks } : {}),
    ...(args.no_review === true ? { review: false } : typeof args.review === "string" ? { review: args.review } : args.no_review === false ? { review: true } : {}),
    ...(typeof args.accept === "boolean" ? { accept: args.accept } : {}),
    ...(typeof args.workdir === "string" ? { workdir: args.workdir } : {}),
    ...(typeof args.branch === "string" ? { branch: args.branch } : {}),
    ...(typeof args.brief === "string" ? { brief: args.brief.trim() } : {}),
  };
  const edited = await missions.edit(mission.id, change, { byAgent: ctx.agentId });
  if ("refused" in edited) return refused(edited.refused);
  const brief = edited.briefFailed ? ` Its brief could not be written: ${edited.briefFailed}.` : "";
  return ok(`Draft ${shortId(mission.id)} changed: ${edited.changed.join(", ")}. Its notice was sent to this chat again, saying so.${brief}`);
}

/** Start it — once git has taken the branch it names, if it names one (`Missions.branchRefusal`). */
async function startChecked(missions: Missions, request: StartRequest, pageOf?: (id: string) => string | null): Promise<{ answer: ToolResult; mission: Mission | null }> {
  const refusal = await missions.branchRefusal(request);
  if (refusal) return { answer: refused(refusal), mission: null };
  const result = missions.start(request);
  // A draft's brief is written before its notice goes: what failed is said to the agent, which can write it again.
  const briefFailed = "drafted" in result && result.drafted ? await result.drafted : null;
  return { answer: started(missions, result, pageOf, briefFailed), mission: "mission" in result ? result.mission : null };
}

/** What the agent says it started or drafted — with the mission's page, where a link goes into its chat (0.8.11). */
function started(missions: Missions, result: ReturnType<Missions["start"]>, pageOf?: (id: string) => string | null, briefFailed: string | null = null): ToolResult {
  if ("refused" in result) return refused(result.refused);
  const { mission } = result;
  // Another of its missions in the same repository (0.8.7): two missions that each merge into one branch were how a
  // joint piece of work ended with two owners. Starting it separately is still the agent's call.
  const beside = missions.sameRepository(mission);
  const reminder = beside.length > 0 ? `\n${beside.map((one) => shortId(one.id)).join(", ")} ${beside.length === 1 ? "is" : "are"} still running in this repo; make it a sub-mission, or start separately? If it belongs to that work, stop this one (\`work\` stop) and hand it out from there.` : "";
  const id = shortId(mission.id);
  const page = pageOf?.(mission.id);
  const pageLine = page ? `\nPage: ${page}` : "";
  if (isDraft(mission)) {
    const brief = missions.briefPath(mission);
    const briefLine = briefFailed ? `\nIts brief could not be written: ${briefFailed}. Write it again with \`edit\`.` : `\nIts brief: ${brief} (yours to change before it starts).`;
    return ok(
      `Drafted mission ${id}: ${mission.goal}\nDone when ${doneWhen(mission)}; signed off by ${signedOffBy(mission)}.${briefLine}${pageLine}\n` +
        `Its notice is in this chat with Start it and Drop it. Nothing runs until the person starts it: their tap, /mission accept ${id}, the dashboard, ` +
        `or their "go" passed on with \`work\` action "start". Change it before then with \`mission\` action "edit". ` +
        `Tell the person what you drafted and how it will be judged done; do not do the work here as well.${reminder}`,
    );
  }
  const state = mission.status === "queued" ? "queued" : "started";
  // Why it waits is the dispatcher's own decision (`blockedBy`), not guessed again here.
  const waits = result.queued ? `\nIt waits because ${result.queued}; it starts by itself once that clears.` : "";
  return ok(`Mission ${id} ${state}: ${mission.goal}${waits}\nDone when ${doneWhen(mission)}.${pageLine}\nIt runs on its own and reports to this chat. Tell the person you started it; do not do the work here as well.${reminder}`);
}

export function createMissionTools(missions: Missions, options: { linkFor?: LinkFor; audit?: Pick<AuditPort, "record"> } = {}): { chat: Tool; inside: Tool } {
  const chat: Tool = {
    requiresApproval: false,
    definition: {
      name: "mission",
      description: `${WHEN_TO_START} ${WHO_SIGNS} ${ONE_OWNER} Action "start" drafts one; "edit" changes your draft before it starts.`,
      parameters: {
        type: "object",
        properties: { action: { type: "string", enum: ["start", "edit"] }, ...START_FIELDS, ...CHAT_FIELDS },
        required: ["action"],
      },
    },
    async execute(args, ctx) {
      if (args.action === "edit") return await editOwn(missions, args, ctx);
      if (args.action !== "start") return refused('In a chat, `mission` drafts one (action "start") or changes your draft ("edit").');
      // A draft unless the person asked for it to run now, in words of their own in this turn (RFC MISSION_DRAFTS §2.1).
      // A turn nobody typed — a job's end, a schedule — proposes, as it always has.
      const said = text(args.said);
      const now = args.now === true;
      if (now && !said) return refused("`now` needs `said`: the person's own words asking for it to run now, as they wrote them. Without them it is a draft they start.");
      if (now && (ctx.senderId === SYSTEM_SENDER || ctx.askedBy || ctx.unattended)) return refused("`now` starts work on a person's own word, in the turn their message started, and this turn is not one. Draft it instead.");
      if (now && typeof args.brief === "string") return refused("A brief goes with a draft. Started at once, the goal says what the work is, or names a brief file by its absolute path.");
      // The chat's task goes with it — its notes and its plan, the ones this turn wrote (`missions/carry.ts`).
      const from = { agentId: ctx.agentId, gatewayId: ctx.gatewayId, chatId: ctx.chatId, ...(ctx.turnId ? { turnId: ctx.turnId } : {}) };
      // A draft whose call names nobody to sign it off is the person's, after its checks — `WHO_SIGNS`'s own answer, as a
      // draft waits for them to start it. Left to the defaults, a model that fills no optional field (Nouva on Gemini
      // Flash, live, 2026-10-31) drafted every long job with the reviewer for the person following it in the chat. Started
      // at once, the person may be leaving: the reviewer, as before.
      const named = args.accept !== undefined || args.no_review !== undefined || text(args.review) !== "";
      const request: StartRequest = {
        ...startFields(args, ctx),
        startedBy: ctx.senderId,
        gatewayId: ctx.gatewayId,
        chatId: ctx.chatId,
        from,
        ...(now ? { said } : { proposed: true, ...(named ? {} : { review: false as const, accept: true }) }),
        ...(typeof args.brief === "string" && args.brief.trim() ? { brief: args.brief.trim() } : {}),
      };
      const { answer, mission } = await startChecked(missions, request, (id) => options.linkFor?.(ctx, { kind: "mission", id }) ?? null);
      // Started without a draft: the words it rests on are on the record, as a person's start is (§2.1).
      if (now && mission) options.audit?.record({ action: "mission_started", actor: `agent ${ctx.agentId}`, agentId: mission.agentId, details: { mission: mission.id, said } });
      return answer;
    },
  };

  const inside: Tool = {
    requiresApproval: false,
    definition: {
      name: "mission",
      description:
        'This mission\'s own actions. "done": the goal is met, with its result as `summary`, its whole `report` and the `files` ' +
        'the person should receive, inside its folder; the daemon then runs the checks. "ask": one `question` for the ' +
        'person; the mission waits for the answer. "fail": it cannot be done, with the `reason` and a `report` of what is left. ' +
        'Each ends this turn. "start": hand a separate piece to another agent as a mission ' +
        `of its own (one level: it starts none). ${ONE_OWNER}`,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["done", "ask", "fail", "start"] },
          summary: { type: "string", description: "done: the result (what the mission achieved) in two or three sentences, the chat's message when it ends. In the person's language, in a formal register." },
          report: { type: "string", description: "done, fail: the whole account of the work, markdown, as long as it needs: what was done and how, what was checked, what was not done, what a person should look at. The person receives it whole as `report.md`. In the person's language, in a formal register." },
          files: { type: "array", items: { type: "string" }, description: "done: files the person should receive (a document, an image, a spreadsheet, a video), paths inside the mission's folder. Not the report, which is sent as `report.md` already. What git tracks in its worktree stays on its branch and is not sent. Never what was made to check the work (evidence, stills, fixtures, an answer key): the report names their paths. None when the brief says to send nothing." },
          question: { type: "string", description: "ask: one question for the person, in their language." },
          reason: { type: "string", description: "fail: why it cannot be done." },
          ...START_FIELDS,
        },
        required: ["action"],
      },
    },
    async execute(args, ctx) {
      const mission = isMissionChat(ctx) ? missions.get(ctx.chatId) : null;
      if (!mission) return refused("This turn is not a mission's.");
      switch (args.action) {
        case "done": {
          const summary = text(args.summary);
          if (!summary) return refused("`done` needs a `summary`: the result, in two or three sentences, for the chat.");
          const report = text(args.report);
          if (!report) return refused("`done` needs a `report`: the whole account of the work, which the person receives as `report.md`.");
          const files: string[] = [];
          for (const file of strings(args.files) ?? []) {
            let path: string;
            try {
              path = resolveWithin(mission.workdir, file);
            } catch {
              return refused(`${file} is not inside the mission's folder (${mission.workdir}). Put the result there first.`);
            }
            // Checked here, while the agent can still name it right: a video named as `worktree/apps/…` from inside the
            // worktree resolved to a path that was not there, and the person got "Not sent as files" (live, 0.8.12).
            const found = statFile(path);
            if (!found || found.isDirectory) {
              return refused(`${file} is not a file: ${path} ${found ? "is a folder" : "does not exist"}. Relative paths start at the mission's folder, ${mission.workdir}. Name each file where it is, then call done again.`);
            }
            files.push(path);
          }
          missions.claim(mission.id, { kind: "done", summary, report, files });
          return claimed(mission.checks.length > 0 ? `Noted. This turn ends here and the daemon runs the checks: ${mission.checks.join("; ")}.` : "Noted. This turn ends here and it goes to the person to accept.", `Done: ${summary}`);
        }
        case "ask": {
          const question = text(args.question);
          if (!question) return refused("`ask` needs one `question`.");
          missions.claim(mission.id, { kind: "ask", question });
          return claimed("Asked. This turn ends here and the mission waits for the answer; it comes back as the next turn.", `Asked: ${question}`);
        }
        case "fail": {
          const reason = text(args.reason);
          if (!reason) return refused("`fail` needs a `reason`.");
          missions.claim(mission.id, { kind: "fail", reason, report: text(args.report) });
          return claimed("Noted. This turn ends here and the mission ends as failed.", `Cannot be done: ${reason}`);
        }
        case "start":
          return (await startChecked(missions, { ...startFields(args, ctx), startedBy: mission.startedBy, gatewayId: mission.gatewayId, chatId: mission.chatId, parentId: mission.id, ...(mission.untrusted ? { untrusted: true } : {}) })).answer;
        default:
          return refused('`action` is one of "done", "ask", "fail", "start".');
      }
    },
  };

  return { chat, inside };
}
