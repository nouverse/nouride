/**
 * What goes into a system prompt, and what comes out.
 *
 * Separated from the assembly so a section module can depend on the shape without importing the
 * builder that owns it.
 */

import type {
  ApprovalLevel,
  Skill,
  ChatType,
  ExecSecret,
  GatewayName,
  LoadedAgent,
  SystemBlock,
  ToolDefinition,
} from "@nouride/shared";
import type { Recall } from "@/modules/memory/index.ts";


/**
 * What the agent needs to know about the machinery it is running inside.
 *
 * Read from live state rather than written in a persona file: which tools exist, whether a
 * human can be asked, and how many round-trips are allowed all depend on config, and a static
 * description would drift into a lie.
 */
export interface HarnessFacts {
  /** Tools that need a human before they run, from the agent's config. */
  approvalRequired: string[];
  /** Whether a human can actually be asked right now. */
  approvalAvailable: boolean;
  /**
   * The exec permission posture, when the agent has `exec`: whether any command already has standing permission. What
   * asks is the approval level's (`approvals`), over one fixed list.
   *
   * Told to the model because it changes what the model should *say*. An agent that does not know
   * commands are gated promises to run things and then reports a refusal, which reads as the
   * harness being broken; one that knows the first use of each command asks can say so up front.
   */
  execPolicy?: { grantsHeld: number };
  /**
   * How much this turn will actually be asked about, after the three layers resolve.
   *
   * Told because it changes what the agent should *say*: one that does not know its calls run
   * unprompted promises to check first and then does not, and one at `trusted` should be more careful
   * rather than less — nothing downstream will stop it.
   */
  approvals?: ApprovalLevel;
  maxToolIterations: number;
  /**
   * How long one reply may take, in milliseconds.
   *
   * Told for the same reason as the round-trip cap, and it was the missing half: a model that knows
   * it has 25 rounds and not that it has five minutes will spend the five minutes waiting inside
   * them. Live, a turn polled a CI run every twenty seconds until the clock ran out.
   */
  maxTurnDurationMs: number;
  /** Slash commands the harness handles before the agent ever sees them. */
  commands: string[];
  /** Whether history is trimmed when the window fills. */
  truncates: boolean;
  /**
   * The credentials directory, when this agent has `exec`.
   *
   * Told to the model because it changes what it should *do*, not just what it may do: without it,
   * an agent that needs a service-account file has no idea one exists and either invents a path or
   * asks the operator to paste a key into the chat — which is the outcome this whole mechanism is
   * built to prevent.
   *
   * The rule travels with the path, and it is stated as a property of the harness rather than as a
   * prohibition. A model told "do not print credentials" still prints one eventually; a model told
   * the files are unreadable to it and must be passed to a script has no reason to try.
   */
  credentialsDir?: string;
  /** Secrets this agent's commands receive as environment variables, and which commands. Names only, never values. */
  execSecrets?: ExecSecret[];
  /**
   * Where the agent's files are: its own directory first, then any declared roots.
   *
   * The prompt said nothing about this, and the result was immediate in testing: asked to read
   * `project/app.js`, the agent tried that relative path, which resolves against its *own* directory
   * rather than the declared workspace root — so a file that plainly existed was reported missing. An
   * agent that cannot see its own layout cannot address it.
   */
  workspace?: { dir: string; privateDir?: string; roots: string[] };
  /**
   * Other agents reachable in this conversation, how to address each one, and how far a chain may run.
   *
   * `mention` is the literal text to write — `<@1111111111111111111>` on Discord, `@some_bot` on
   * Telegram — supplied by that agent's own connection. Absent where the platform has no mention for
   * it, and then the agent's id is the fallback, which is what the text matcher understands.
   */
  otherAgents?: {
    names: string[];
    /** Agents in no reach of this room: their own bot cannot read it (`Gateway.sees`), so a tag here reaches nobody. */
    absent?: string[];
    mentions?: Record<string, string>;
    /**
     * Agent id → one line of what it is for, from its IDENTITY.md (`describePeers`), bounded per peer and in total. A peer
     * was picked by its bare id before: an agent choosing whom to ask could not tell the infra agent from the writer.
     */
    about?: Record<string, string>;
    /** This agent is the orchestrator (`[daemon] orchestrator`), so in a room it is the front desk. */
    frontDesk?: boolean;
    maxHops: number;
    /**
     * How a handover actually travels from *this* conversation.
     *
     * `"mention"` in a room the other bots can see: the tag is delivered by the platform, or by the
     * engine when the peer shares this bot. `"bus"` in a one-to-one chat, where no other connection
     * will ever see this message and `ask_agent` is the only thing that reaches anybody.
     *
     * Told to the model because the two are not interchangeable and the wrong one fails silently: an
     * @mention in a DM is a word in a message, and nothing anywhere reports that it went nowhere.
     */
    channel: "mention" | "bus";
  };
  /**
   * The install directory — where `nouride` has to be run from.
   *
   * The CLI resolves the install relative to its working directory, so `nouride status` from anywhere
   * else reports no daemon while one is running perfectly. Told to the model because it will
   * otherwise work that out the expensive way: seen live, an agent read `data/.control-token` by hand
   * to build a command that would have worked without it — and reading that file is a hardline class,
   * so it cost an approval to do something it never needed to do.
   */
  installDir?: string;
  /**
   * The user-space bin directory boot puts first on $PATH (`<dataDir>/../bin`), absolute.
   *
   * The prompt used to name it as `.nouride/bin/` — relative, so it resolved to the shared workspace
   * and a binary downloaded "there" was not on $PATH at all.
   */
  binDir?: string;
  /**
   * Where each agent's commands run as its own user (0.8.0): its HOME, its own folder — `binDir` is then its own
   * `~/.local/bin` — and the bin directory every agent shares, on PATH behind it, to run and never to change.
   */
  ownHome?: string;
  sharedBinDir?: string;
  /** It is the orchestrator, its own user, and installs what every agent runs (`nouride tools run`). */
  sharesTools?: boolean;
  /** A `delegate` helper: nobody reads it but the agent that asked, and nobody can answer it. */
  helper?: boolean;
  /** Work nobody watches — a mission's turn, a job's or a webhook's run (`TurnRequest.unattended`): no line of it goes out as it is written. */
  unattended?: boolean;
  /** `mission` starts one from this turn: a chat's, not a mission's own or a schedule's (`WHEN_TO_START`, 0.8.5). */
  startsMissions?: boolean;
  /**
   * How many helpers this agent may have working in the background at once — `[delegate] max_background`, resolved for
   * this turn (`AgentToolset.backgroundHelpers`). Absent or 0: `delegate` runs in the foreground only, and the harness
   * says nothing about the background.
   */
  backgroundHelpers?: number;
  /**
   * The models this agent's three tiers name, resolved for this turn (`tierModel`) — what `tier` on `delegate` and
   * `ask_agent` chooses between (0.8.0). Absent: neither tool is held, and TOOLS says nothing of tiers.
   */
  modelTiers?: { small: string; default: string; high: string };
}

export interface PromptContext {
  agent: LoadedAgent;
  tools: ToolDefinition[];
  harness: HarnessFacts;
  gateway: GatewayName;
  /** The connection's own formatting line (`Gateway.formatting`); absent, the engine's for the web. */
  formatting?: string;
  chatId: string;
  chatType: ChatType;
  /** The room's name, where it has one (`roomName`, 0.7.24). The same for every turn in the room, so the cache holds. */
  roomName?: string;
  sessionId: string;
  model: string;
  /** Injected so prompts are reproducible in tests. */
  now: Date;
  timezone: string;
  /**
   * The daemon started this turn — a schedule, a background job's end, an answered approval, a resume — and no person
   * sent its message. Its sender is `nouride:system`, which no `[[people]]` entry names, so without this it read as a
   * stranger's request (#13).
   */
  systemEvent?: boolean;
  /** The platform's display name for the sender. Untrusted — anyone can set their own. */
  senderName?: string;
  /**
   * Whether `senderName` came from an account this daemon authenticated.
   *
   * A third standing, between the two below: weaker than a `[[people]]` entry, which the operator
   * wrote deliberately, and much stronger than a platform handle, which the sender chose. It is the
   * dashboard case — somebody signed in — and without it the agent is told nothing at all about who
   * it is talking to in its own UI, which is where the operator actually is.
   */
  senderVerified?: boolean;
  /**
   * The sender, matched against `[[people]]` by gateway-scoped id.
   *
   * Separate from `senderName` because the two have completely different standing. This one was
   * written by the operator and matched on an id the sender cannot choose; that one is a string the
   * sender types into their own profile. Collapsing them would mean a rename to "Gading" is
   * indistinguishable from being Gading.
   */
  person?: { name: string; notes?: string };
  /**
   * What is remembered and may be shown in this chat — the speaker's profile, `shared/MEMORY.md`, the
   * newest timeline lines (`modules/memory`, already filtered by who is asking where).
   *
   * Absent where memory is not wired, and then the section is simply not there.
   */
  recall?: Recall;
  /**
   * Whether this install has named anyone in `[[people]]`.
   *
   * It changes what an *unmatched* sender means. On a single-user install, silence is fine — there
   * is nobody else to mistake them for. On a household install, silence is dangerous: a model that
   * has met the household fills it with the likeliest name, and greets the operator's partner as the
   * operator (as USER.md, read on every turn until 0.7.0, made it do). Wrong identity, stated
   * confidently, is worse than none — so when people are configured, an unmatched sender is told
   * about explicitly.
   */
  peopleConfigured?: boolean;
  /**
   * The same sender as `platform:senderId`, when that is a different string.
   *
   * The id to *record*, and usually not the same as the one to quote. On a platform where several of
   * our bots share a room, which connection a message arrives on depends on which bot was tagged — so
   * recording the connection-qualified id teaches the daemon a name that stops working the moment the
   * person addresses somebody else. This form covers them on that platform, whichever bot they talk to.
   */
  personRefPlatform?: string;
  /**
   * This sender as `gatewayId:senderId` — the id `nouride people set` takes.
   *
   * Needed because the CLI replaced a tool that did not need it. `person_manage` recorded whoever
   * sent the message being handled and had no id parameter at all; a command has no current sender to
   * fall back on. Without this the agent would have to reconstruct the id from the gateway name and
   * whatever it thinks the sender id is, and a wrong guess writes a name onto somebody else.
   */
  personRef?: string;
  /**
   * The gateway *instance* id (`telegram:main`), not the platform name.
   *
   * `cron_manage` never needed it — it pinned every job to `ctx.gatewayId`/`ctx.chatId` itself. The
   * CLI takes them as flags, so the prompt has to supply the pair or the agent invents one and
   * schedules a reminder into a conversation that does not exist.
   */
  gatewayId?: string;
  /** Body of a skill loaded on demand for this turn. */
  activeSkill?: { name: string; body: string };
  /**
   * Skills a project brought with it, scanned this turn.
   *
   * Separate from `agent.skills` because they have a different lifetime — the pack's load once, these
   * are re-read whenever the file on disk changes — but rendered in the same list, because to the
   * model there is no difference worth knowing: it is a thing it can read when the task matches.
   */
  projectSkills?: Skill[];
  /** Budget for the whole system prompt. Sections trim from the bottom when exceeded. */
  maxTokens?: number;
}

export interface BuiltPrompt {
  /** The full system prompt — every block joined. Exists so callers that do not care about caching can use one string. */
  text: string;
  /**
   * The prompt split at its stability boundaries, in order, with a cache hint on each.
   *
   * Joined with a blank line this is exactly `text`; the split carries no content decision, only
   * where a provider that supports prompt caching should place its breakpoints.
   */
  blocks: SystemBlock[];
  tokens: number;
  /**
   * What went in, in order, with who wrote each — see `Section.origin`.
   *
   * Names and sizes rather than content: the caller that needs the text already has `text`, and the
   * caller that needs this is deciding what it may show.
   */
  sections: { name: string; origin: Section["origin"]; chars: number }[];
  /**
   * `text`, with every section Nouride wrote replaced by a one-line note.
   *
   * What `/prompt` prints. The operator gets their own material verbatim and can see where the
   * product's blocks sit between it; they do not get the product's blocks.
   */
  operatorText: string;
  /** Section names dropped to fit the budget, in the order they were dropped. */
  trimmed: string[];
  /**
   * Who is speaking — the `dynamic` section, rendered — to be sent after the conversation (`ChatParams.tail`), not in
   * `blocks`. Counted in `tokens`. Empty when there is none, or when the budget dropped it.
   *
   * In the system prompt it sat in front of the conversation, so a change of speaker — a system event's turn in a DM,
   * another person in a group — started the conversation's cache over: 70k–120k tokens written again (live,
   * 2026-10-22). After it, it costs its own few hundred tokens and nothing behind it moves.
   */
  situation: string;
}

/**
 * How often a section's bytes change — which is what decides where a cache breakpoint can go.
 *
 * Not the same question as what a section is *about*, and the two answers disagree: `harness` is
 * generated rather than loaded from a file, so it reads as dynamic, but it changes only when the
 * agent's toolset or exec posture does, which within a conversation is never. It sat outside the
 * cache for that reason alone, and it is the largest single block in the prompt.
 *
 *   - `files`    — loaded from the agent's pack: identity, agents, skills, memory.
 *   - `capability` — derived from what the agent can do: the harness.
 *   - `chat`     — what is remembered about the people in this chat (recall): moved by a fact written
 *                  now, a cut, the nightly pass, midnight, and in a group by who has been speaking
 *                  lately — never by who is speaking now, and never per request (M2).
 *   - `request`  — what a request can move: the date and the installed programs in runtime. Who is
 *                  speaking is `request` too, and is sent after the conversation (`BuiltPrompt.situation`).
 *
 * A boundary between two tiers is a breakpoint: three system breakpoints and the conversation's own
 * make the four the Anthropic API allows (`packages/llm/src/anthropic.ts`). The last tier never gets
 * one, because an entry written after per-request bytes is one nothing will ever read.
 */
export type Stability = "files" | "capability" | "chat" | "request";

export interface Section {
  name: string;
  content: string;
  /** Sections that define who the agent is are never dropped. */
  essential: boolean;
  stability: Stability;
  /**
   * Who wrote this — the operator, or Nouride.
   *
   * `/prompt` is a debugging tool for the person running the daemon, and what they need from it is
   * their own material: their SOUL, their memory, their skills, the facts about this install. The
   * harness block is not theirs — it is the product's own instructions, shipped in the binary, and
   * an install being able to print it verbatim on request makes it public.
   *
   * Declared per section rather than filtered by name in the dump, so a section added later has to
   * answer the question. A blocklist keyed on names would silently leak the next one.
   */
  origin: "operator" | "shipped";
}

/**
 * Trim order when the prompt exceeds its budget — the reverse of importance.
 *
 * Dynamic context is regenerated every turn, memory is on disk and can be re-read with a
 * tool, and skills are discoverable. Identity, the user, and the other agents are not
 * recoverable from anywhere else, so they stay. Recall goes before the pack's memory: every
 * part of it is one `memory_read` or `memory_search` away.
 *
 * `skills:short` is a step, not a section: the skills list kept, each skill cut to its first sentence. 0.8.12 shipped
 * sixteen built-in skills whose descriptions are written to be picked by, and on a model whose window is not known —
 * many a local one — the full list pushed the agent's own MEMORY.md out of the prompt (the upgrade run, before the
 * tag). A skill's name and first sentence say when to open it; the agent's notes are said nowhere else.
 */
export const TRIM_ORDER = ["dynamic", "recall", "skills:short", "memory", "skills"] as const;

/** The trim step that shortens the skills list rather than dropping a section (`TRIM_ORDER`). */
export const SHORTEN_SKILLS = "skills:short";

export const DELIMITER_START = "<<<NOURIDE:";
export const DELIMITER_END = ">>>";

/**
 * The harness block's shared view of this agent's toolset.
 *
 * Computed once in `harness.ts` and handed to each section: three of the five read `toolNames`,
 * and recomputing it per section is how two sections come to disagree about what the agent has.
 */
export interface HarnessView {
  ctx: PromptContext;
  /** Every tool this agent is offered, by name. */
  toolNames: string[];
  /** The ones behind the approval gate. */
  gated: string[];
  /** The ones that are not. */
  free: string[];
}
