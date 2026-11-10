import type { Client } from "@nouride/cli-kit";
import { saidSaved } from "@/cli/saved.ts";
import { BOLD, DIM, GREEN, RED, RESET, say, usageError, usageLines, YELLOW, flagValue, hasFlag, knownAction, unknownAction, wholeNumber } from "@nouride/cli-kit";
import { memoryTags } from "./memory-tags.ts";
import { isModelTier } from "@nouride/shared";

/**
 * `nouride memory` — what the agents remember (`docs/SPEC.md` §12).
 *
 * Over the control API like every command; `modules/memory` decides everything.
 *
 * **The read views are the operator's.** `episodes`, `show` and `proposals` print conversations from
 * every chat, unfiltered, which is right in a terminal and wrong in a group chat. So they refuse when
 * run from inside an agent's turn (the daemon sets `NOURIDE_CHAT_ID` there) and point at
 * `memory_search`, which answers only what that chat may see.
 */

interface MemorySettingsView {
  pass: boolean;
  passAt: string;
  passPerNight: number;
  passMaxTokens: number;
  passProvider: string;
  passModel: string;
  maxAttempts: number;
  facts: string;
  proposeShared: boolean;
  promptRecent: number;
  /** Absent from daemons before 0.7.27, which always recalled. */
  recall?: boolean;
  transcriptDays: number;
  archive: boolean;
  semantic: { enabled: boolean; provider: string; model: string };
}

/** What `/memory/status` says of the pass's backlog — `modules/memory/backlog.ts`. Absent from daemons before 0.7.12. */
interface BacklogView {
  waiting: number;
  oldest: string | null;
  perNight: number;
  days: number;
  agents: { agent: string; waiting: number; perDay: number }[];
  behind: string[];
  enough: number | null;
}

interface EpisodeView {
  id: string;
  status: string;
  kind: string;
  day: string;
  agents: string[];
  participants: string[];
  tags: string[];
  summary?: string;
}

interface ProposalView {
  id: string;
  subject: string;
  why: string;
  current?: string;
  operation: { op: "add" | "update" | "remove"; section?: string; text?: string };
}


/** The words of a command, without its flags and their values. */
function words(args: string[]): string[] {
  return args.slice(1).filter((arg, index, all) => !arg.startsWith("--") && !all[index - 1]?.startsWith("--"));
}

/** What a person types for a switch: `on` as readily as `true`. Anything else is passed on, and refused by the settings check. */
const bool = (raw: string): unknown => {
  const word = raw.trim().toLowerCase();
  return ["true", "on", "yes"].includes(word) ? true : ["false", "off", "no"].includes(word) ? false : raw;
};
const number = (raw: string): unknown => Number(raw);
const text = (raw: string): unknown => (raw === "-" ? "" : raw);

/** One field of the settings, as typed. */
const field = (name: keyof MemorySettingsView, parse: (raw: string) => unknown) => (raw: string) => ({ [name]: parse(raw) });

/**
 * `set` values as typed: lists comma-separated, booleans and numbers as written. The pass's model is
 * `<provider>/<model>` — the two go together, since agents use different providers — and `-` puts it
 * back on each agent's own.
 */
const SETTABLE: Record<string, (raw: string) => Record<string, unknown>> = {
  pass: field("pass", bool),
  pass_at: field("passAt", text),
  pass_per_night: field("passPerNight", number),
  pass_max_tokens: field("passMaxTokens", number),
  pass_model: (raw) => {
    if (raw === "-") return { passProvider: "", passModel: "" };
    // A tier (0.8.0) is each agent's own model of it, on its own provider — so the provider goes with it.
    if (isModelTier(raw)) return { passProvider: "", passModel: raw };
    const slash = raw.indexOf("/");
    return slash > 0 ? { passProvider: raw.slice(0, slash), passModel: raw.slice(slash + 1) } : { passModel: raw };
  },
  max_attempts: field("maxAttempts", number),
  facts: field("facts", text),
  propose_shared: field("proposeShared", bool),
  prompt_recent: field("promptRecent", number),
  recall: field("recall", bool),
  transcript_days: field("transcriptDays", number),
  archive: field("archive", bool),
};

/**
 * What waits for the nightly pass, in a line — and when what waits is more than a week's filing at the count set, the
 * count that would file it, from the pace each agent's conversations kept (`modules/memory/backlog.ts`).
 */
function sayBacklog(backlog: BacklogView): void {
  if (backlog.waiting === 0) return say(`${BOLD}waiting${RESET}          nothing (the pass keeps up)`);
  const oldest = backlog.oldest ? `, the oldest from ${backlog.oldest}` : "";
  say(`${BOLD}waiting${RESET}          ${backlog.waiting} conversation(s)${oldest}`);
  if (backlog.enough === null) return;
  const pace = backlog.agents
    .filter((row) => row.perDay > 0)
    .map((row) => `${row.agent || "no agent"} ${row.perDay} a day`)
    .join(", ");
  const over = backlog.days === 7 ? "over the last 7 days" : `over the ${backlog.days} day(s) since the first conversation`;
  say(`${YELLOW}!${RESET} ${backlog.behind.length ? "falling behind" : "more waiting than a week of nights files"}: ${pace || "no conversations lately"} ${over}, and the pass files ${backlog.perNight} per agent a night`);
  say(`${DIM}  nouride memory set pass_per_night ${backlog.enough} files what waits within a week at this pace; pass_max_tokens caps what a night may spend${RESET}`);
}

/** The pass's runs, as `/memory/status` says them. `runningSince`, `next` and a run's `scheduled` are absent before 0.7.27. */
interface PassRunsView {
  running: boolean;
  runningSince?: number;
  timeZone: string;
  lastRun: { finishedAt: number; filed: number; failed: number; scheduled?: boolean } | null;
  next?: { at: number; due: boolean } | null;
}

/**
 * `Thu 23 Oct, 01:05`, on the daemon's clock. Put together from its parts: a whole format joins them as ICU sees fit —
 * "Thu 23 Oct, 01:05" in one engine, "Thu 23 Oct at 01:05" in another.
 */
function when(at: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/** Whether a pass runs now, what the last one did and when, and when the next one is. */
function sayRuns(pass: PassRunsView): void {
  if (pass.running) say(`${BOLD}running${RESET}          ${YELLOW}a pass is running${RESET}${pass.runningSince ? ` since ${when(pass.runningSince, pass.timeZone)}` : ""}`);
  const last = pass.lastRun;
  if (last) say(`${BOLD}last run${RESET}         ${when(last.finishedAt, pass.timeZone)} ${DIM}${last.filed} filed${last.failed ? `, ${last.failed} failed` : ""}${last.scheduled === false ? ", run by hand" : ""}${RESET}`);
  else say(`${BOLD}last run${RESET}         none yet`);
  if (pass.next) say(`${BOLD}next run${RESET}         ${pass.next.due ? "due now (it waits for the turns running to end)" : when(pass.next.at, pass.timeZone)}`);
}

function refuseInsideChat(): boolean {
  if (!process.env.NOURIDE_CHAT_ID) return false;
  say(`${YELLOW}!${RESET} This prints every chat's memory, and you are inside a chat.`);
  say(`${DIM}  Use the memory_search tool: it answers only what this chat may see.${RESET}`);
  return true;
}

function printEpisodes(episodes: EpisodeView[]): void {
  if (episodes.length === 0) return say(`${DIM}no conversations${RESET}`);
  let day = "";
  for (const episode of [...episodes].reverse()) {
    if (episode.day !== day) {
      day = episode.day;
      say(`${BOLD}${day}${RESET}`);
    }
    const tags = episode.tags.length ? ` ${DIM}${episode.tags.map((tag) => `#${tag}`).join(" ")}${RESET}` : "";
    const summary = episode.summary ?? `${DIM}(waiting for the nightly pass)${RESET}`;
    say(`  ${episode.agents.join(",") || "archive"} ${DIM}with ${episode.participants.join(", ")}${RESET}${tags} ${summary} ${DIM}⟨${episode.id}⟩${RESET}`);
  }
}

export async function memoryCommand(client: Client, args: string[]): Promise<void> {
  const [action, target, value] = args;
  knownAction("memory", action, ["tags", "settings", "set", "episodes", "show", "pass", "proposals", "approve", "deny", "changes", "failed", "retry", "undo", "forget", "reindex", "embed"]);
  if (action === "tags") return await memoryTags(client, args.slice(1));

  if (action === undefined || action === "settings") {
    const view = await client.get<MemorySettingsView>("/memory/settings");
    const budget = view.passMaxTokens ? `, at most ${view.passMaxTokens.toLocaleString("en-US")} tokens a night` : "";
    say(`${BOLD}nightly pass${RESET}     ${view.pass ? `at ${view.passAt}` : "off"} ${DIM}${view.passPerNight} per agent per night${budget}, ${view.maxAttempts} attempts, with ${view.passProvider ? `${view.passProvider}/${view.passModel}` : view.passModel ? `each agent's own ${view.passModel}-tier model` : "each agent's own model"}${RESET}`);
    // An operator's to read; anyone may read the settings, so a refusal here leaves the line out rather than the command.
    const status = view.pass ? await client.softGet<{ backlog?: BacklogView; pass?: PassRunsView | null }>("/memory/status").catch(() => null) : null;
    if (status?.pass) sayRuns(status.pass);
    if (status?.backlog) sayBacklog(status.backlog);
    say(`${BOLD}facts${RESET}            ${view.facts} ${DIM}(a person's own setting on the Memory page wins)${RESET}`);
    say(`${BOLD}propose_shared${RESET}   ${view.proposeShared ? "on" : "off"}`);
    say(`${BOLD}recall${RESET}           ${view.recall === false ? "off: nothing remembered goes into prompts; agents still search" : "on"} ${DIM}(a person's own setting on the Memory page wins)${RESET}`);
    say(`${BOLD}prompt_recent${RESET}    ${view.promptRecent} conversation summaries in each prompt`);
    say(`${BOLD}transcripts${RESET}      ${view.transcriptDays === 0 ? "kept forever" : `readable ${view.transcriptDays} day(s)${view.archive ? ", then archived" : ", then dropped"}`}`);
    return say(`${BOLD}semantic search${RESET}  ${view.semantic.enabled ? `${view.semantic.provider} · ${view.semantic.model}` : "off"}`);
  }

  if (action === "set") {
    const setting = target ? SETTABLE[target] : undefined;
    if (!setting || value === undefined) usageLines(`nouride memory set <${Object.keys(SETTABLE).join("|")}> <value>`);
    const answer = await client.put<{ restartRequired?: boolean }>("/memory/settings", setting(value));
    return saidSaved(`${target} = ${value}`, answer);
  }

  if (action === "episodes") {
    if (refuseInsideChat()) return;
    const limit = flagValue(args, "--limit");
    const filters = {
      agent: flagValue(args, "--agent"),
      person: flagValue(args, "--person"),
      tag: flagValue(args, "--tag"),
      since: flagValue(args, "--since"),
      until: flagValue(args, "--until"),
      status: flagValue(args, "--status"),
      limit: limit === undefined ? undefined : String(wholeNumber("memory", limit)),
    };
    const query = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1])));
    const q = words(args).join(" ");
    if (q) query.set("q", q);
    const { episodes } = await client.get<{ episodes: EpisodeView[] }>(`/memory/episodes?${query}`);
    return printEpisodes(episodes);
  }

  if (action === "show") {
    if (refuseInsideChat()) return;
    if (!target) usageError(`usage: nouride memory show <episode>`);
    const { episode, archived } = await client.get<{ episode: EpisodeView & { transcript: string; people: string[] }; archived?: string }>(`/memory/episodes/${encodeURIComponent(target)}`);
    say(`${BOLD}${episode.id}${RESET} ${DIM}${episode.status} · ${episode.kind} · ${episode.agents.join(", ")} with ${episode.people.join(", ")}${RESET}`);
    if (episode.summary) say(episode.summary);
    return say(`\n${episode.transcript.trim() || (archived ? `${DIM}(archived)${RESET}\n${archived}` : `${DIM}(transcript no longer kept)${RESET}`)}`);
  }


  if (action === "pass") {
    const report = await client.post<{ cut: number; filed: number; failed: { episode: string; reason: string }[]; problems?: { what: string; problem: string }[]; applied: number; proposed: number; tidied: number; compacted: number; restored: number; waiting: number; stopped?: string; tags?: { folded: number; created: number; dropped: number }; spent?: { tokens: number; estimated: boolean } }>("/memory/pass");
    say(
      `${GREEN}✓${RESET} cut ${report.cut}, filed ${report.filed}${report.failed.length ? `, ${RED}${report.failed.length} failed${RESET}` : ""}` +
        `; ${report.applied} fact(s) kept, ${report.proposed} proposed, ${report.tidied} profile(s) tidied, ${report.compacted} compacted${report.restored ? `, ${report.restored} transcript(s) restored` : ""}${report.waiting ? `, ${report.waiting} waiting for the next night` : ""}`,
    );
    if (report.tags) say(`${DIM}tags: ${report.tags.created} new, ${report.tags.folded} folded into tags in use, ${report.tags.dropped} dropped${RESET}`);
    if (report.spent) say(`${DIM}${report.spent.tokens.toLocaleString("en-US")} tokens used by its own calls${report.spent.estimated ? " (estimated: a provider reported none)" : ""}${RESET}`);
    // The pass's own warning (`boot/memory-pass.ts`): more new tags than a third of what it filed.
    if (report.tags && report.filed >= 3 && report.tags.created * 3 > report.filed) say(`${YELLOW}!${RESET} many new tags for ${report.filed} conversation(s): a changed model or prompt, or ${BOLD}nouride memory tags tidy${RESET}`);
    if (report.stopped) say(`${YELLOW}!${RESET} stopped early: ${report.stopped}`);
    // What it passed over and went on without: a file it could not read, a chat or a day hub it could not write.
    for (const problem of report.problems ?? []) say(`${YELLOW}!${RESET} passed over ${problem.what}${DIM}: ${problem.problem}${RESET}`);
    return;
  }

  if (action === "proposals") {
    if (refuseInsideChat()) return;
    const { proposals } = await client.get<{ proposals: ProposalView[] }>("/memory/proposals");
    if (proposals.length === 0) return say(`${DIM}nothing waiting${RESET}`);
    for (const p of proposals) {
      const what = p.operation.op === "add" ? `add "${p.operation.text}"` : p.operation.op === "update" ? `change "${p.current}" to "${p.operation.text}"` : `remove "${p.current}"`;
      say(`${BOLD}${p.id}${RESET} ${DIM}${p.subject} (${p.why})${RESET}\n    ${what}`);
    }
    return say(`${DIM}nouride memory approve <id> | deny <id>${RESET}`);
  }

  if (action === "approve" || action === "deny") {
    if (!target) usageError(`usage: nouride memory ${action} <id>`);
    await client.post(`/memory/proposals/${encodeURIComponent(target)}/${action}`);
    return say(`${GREEN}✓${RESET} ${target} ${action === "approve" ? "applied" : "denied"}`);
  }

  if (action === "changes") {
    const person = flagValue(args, "--person");
    const { changes } = await client.get<{ changes: { at: number; subject: string; change: string; text: string; previous?: string; cause: string }[] }>(
      `/memory/changes${person ? `?subject=${encodeURIComponent(person)}` : ""}`,
    );
    if (changes.length === 0) return say(`${DIM}nothing changed${RESET}`);
    for (const change of changes) {
      say(`${DIM}${new Date(change.at).toLocaleString()}${RESET} ${BOLD}${change.change}${RESET} ${change.subject} ${DIM}(${change.cause})${RESET} ${change.text}`);
      if (change.previous) say(`  ${DIM}was: ${change.previous.replace(/\n/g, " | ")}${RESET}`);
    }
    return;
  }

  if (action === "failed") {
    const { failed } = await client.get<{ failed: { episodeId: string; attempts: number; lastError: string | null }[] }>("/memory/failed");
    if (failed.length === 0) return say(`${DIM}nothing failed${RESET}`);
    for (const f of failed) say(`${RED}✗${RESET} ${f.episodeId} ${DIM}${f.attempts} tries${f.lastError ? `: ${f.lastError}` : ""}${RESET}`);
    return say(`${DIM}nouride memory retry [<episode>]${RESET}`);
  }

  if (action === "retry") {
    await client.post("/memory/retry", target ? { episode: target } : {});
    return say(`${GREEN}✓${RESET} ${target ?? "every failed conversation"} will be tried on the next pass`);
  }

  if (action === "undo") {
    if (!target) usageError(`usage: nouride memory undo <person|shared>`);
    const result = await client.post<{ restored: boolean }>(`/memory/documents/${encodeURIComponent(target)}/undo`);
    return say(result.restored ? `${GREEN}✓${RESET} ${target} is back one version` : `${DIM}${target} has no earlier version${RESET}`);
  }

  if (action === "forget") {
    if (!target) usageError(`usage: nouride memory forget <person> [--anonymize]`);
    const mode = hasFlag(args, "--anonymize") ? "anonymize" : "forget";
    const result = await client.post<{ episodesDeleted: number; factsRemoved: number; summariesRewritten: number; summariesAnonymized: number; flagged: string[]; unreadable?: string[]; proposals: number }>(
      "/memory/forget",
      { person: target, mode },
    );
    say(
      `${GREEN}✓${RESET} ${mode === "forget" ? "forgot" : "hid"} ${target}: ${result.episodesDeleted} conversation(s) deleted, ${result.factsRemoved} fact(s) removed, ` +
        `${result.summariesRewritten} summary(ies) rewritten, ${result.summariesAnonymized} anonymized, ${result.proposals} proposal(s)`,
    );
    for (const id of result.flagged) say(`  ${YELLOW}!${RESET} ${id} ${DIM}still named them after a rewrite: anonymized; read it${RESET}`);
    for (const id of result.unreadable ?? []) say(`  ${YELLOW}!${RESET} ${id} ${DIM}its archived transcript could not be read, and still names them${RESET}`);
    say(`${DIM}the vault's weekly snapshots taken before now keep them until [daemon] backup_keep rotates them out${RESET}`);
    say(`${DIM}a chat still open with them keeps what was said until /new or a rollover, and the turn log for [retention] session_days${RESET}`);
    return;
  }

  if (action === "reindex") {
    const report = await client.post<{ episodes: number; profiles: number; dropped: number; problems: { file: string; problem: string }[] }>("/memory/reindex");
    say(`${GREEN}✓${RESET} reindexed ${report.episodes} conversation(s) and ${report.profiles} profile(s)`);
    for (const problem of report.problems) say(`  ${RED}✗${RESET} ${problem.file} ${DIM}${problem.problem}${RESET}`);
    return;
  }

  if (action === "embed") {
    const status = await client.post<{ items: number; model: string }>("/memory/embed");
    return say(`${GREEN}✓${RESET} embedding in the background with ${status.model}: ${status.items} so far. ${DIM}Watch it on the dashboard's Memory → Settings.${RESET}`);
  }

  // Every action `knownAction` lets through is answered above; one that reaches here is a new one with no branch yet.
  unknownAction("memory", String(action));
}
