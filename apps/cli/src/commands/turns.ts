/**
 * `nouride turns` — the newest turns and what each cost; `nouride turns show <id>` — one turn whole.
 *
 * What a slow or expensive turn did used to be read off three places that did not share a key: the dashboard's
 * steps, `llm_usage` by session, the audit log by chat. Each row now carries the turn's id, and this prints them
 * together: the question, every model call with its tokens, cost, latency and retries, the steps, the tool calls.
 */

import { clip, oneLine, plural, EDITED, isDelegated } from "@nouride/shared";
import type { Client } from "@nouride/cli-kit";
import { flagValue, BOLD, DIM, RESET, YELLOW, say, summarize, usageError, knownAction, wholeNumber } from "@nouride/cli-kit";
import type { ModelCall, TurnInspection, TurnSummary } from "@nouride/cli-kit";

export async function turns(client: Client, args: string[]): Promise<void> {
  knownAction("turns", args[0], ["show", "list"]);
  if (args[0] === "show") {
    const id = args[1];
    if (!id) usageError("usage: nouride turns show <id>", "`nouride turns` lists the newest, with their ids");
    return show(await client.get<TurnInspection>(`/turns/${encodeURIComponent(id)}`));
  }
  const asked = flagValue(args, "--limit");
  const limit = asked === undefined ? 20 : wholeNumber("turns", asked);
  const agent = flagValue(args, "--agent");
  const { turns: rows } = await client.get<{ turns: TurnSummary[] }>(
    `/turns?limit=${encodeURIComponent(limit)}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`,
  );
  if (rows.length === 0) return say(`${DIM}no turns recorded${RESET}`);
  for (const row of rows) {
    const cost = row.usd === null ? (row.calls > 0 ? "unpriced" : "—") : `$${row.usd.toFixed(4)}`;
    // A turn that answered a person's edit is marked before the words it answered, which are the edited ones.
    const edited = row.cause?.via === EDITED ? `${DIM}edited ·${RESET} ` : "";
    // A delegate's own turn (0.7.26): its calls are counted in the turn that asked, so it names that instead.
    const counted = isDelegated(row.cause)
      ? `↳ ${row.cause.via}${row.cause.parent ? ` for ${row.cause.parent}` : ""}`
      : `${row.calls} ${plural(row.calls, "call")} · ${cost}`;
    say(`${DIM}${minute(row.startedAt)}${RESET} ${row.id} ${BOLD}${row.agentId}${RESET} ${tone(row.status)} ${DIM}${counted}${RESET}  ${edited}${clip(oneLine(row.prompt), 60)}`);
  }
  say(`${DIM}nouride turns show <id> (a shortened id works when it names one turn)${RESET}`);
}

function show(found: TurnInspection): void {
  const { turn, totals, calls, steps, audit } = found;
  const took = turn.endedAt ? ` · ${seconds(turn.endedAt - turn.startedAt)}` : "";
  say(`${BOLD}${turn.id}${RESET} ${turn.agentId} · ${tone(turn.status)} · ${second(turn.startedAt)}${took}`);
  say(`${DIM}asked${RESET}   ${clip(oneLine(turn.prompt), 200)}`);
  // A person's edit: of the message it answers, edited while it waited, or of one an earlier turn answered.
  if (turn.cause?.via === EDITED) say(`${DIM}edited${RESET}  ${turn.cause.of === turn.messageId ? "before it was answered" : `message ${turn.cause.of}, answered again`}`);
  // A delegate's own turn (0.7.26): the job it ran as, and the turn that asked — where its calls and audit rows are.
  if (isDelegated(turn.cause)) {
    say(`${DIM}for${RESET}     ${turn.cause.via}${turn.cause.job ? ` · job ${turn.cause.job}` : ""}${turn.cause.parent ? ` · asked by ${turn.cause.parent}` : ""}`);
    if (turn.cause.parent) say(`${DIM}        its model calls and tool calls' audit rows are counted there: nouride turns show ${turn.cause.parent}${RESET}`);
  }
  if (turn.error) say(`${DIM}error${RESET}   ${turn.error}`);

  const cached = totals.cachedInputTokens > 0 ? ` (${count(totals.cachedInputTokens)} cached)` : "";
  // Every call unpriced is "unpriced", not "$0.0000" — a figure that reads as a price.
  const cost = totals.calls > 0 && totals.unpriced === totals.calls ? "unpriced" : `$${totals.usd.toFixed(4)}${totals.unpriced > 0 ? `, ${totals.unpriced} unpriced` : ""}`;
  const retries = totals.retries > 0 ? ` · ${YELLOW}${totals.retries} ${plural(totals.retries, "retry", "retries")}${RESET}` : "";
  say();
  say(
    `${BOLD}model calls${RESET} ${totals.calls} · ${count(totals.inputTokens)} in${cached} · ${count(totals.outputTokens)} out · ` +
      `${cost} · ${seconds(totals.latencyMs)} waiting, slowest ${seconds(totals.slowestMs)}${retries}`,
  );
  for (const call of calls) say(`  ${callLine(call, turn.agentId)}`);

  if (steps.length > 0) {
    say();
    say(`${BOLD}steps${RESET}`);
    let previous = turn.startedAt;
    for (const step of steps) {
      say(`  ${DIM}+${seconds(step.at - previous).padStart(6)}${RESET} ${step.kind.padEnd(11)} ${clip(oneLine(step.text), 110)}`);
      previous = step.at;
    }
  }

  // What each model request carried (0.7.26): about how big, what was cleared out of it and kept where, a summary in it.
  if (found.contexts?.length) {
    say();
    say(`${BOLD}requests${RESET}`);
    for (const line of found.contexts) say(`  ${requestLine(line)}`);
  }

  // What it handed to the background, each a turn of its own (0.7.26).
  if (found.delegated?.length) {
    say();
    say(`${BOLD}handed off${RESET}`);
    for (const handed of found.delegated) {
      const took = handed.endedAt ? ` · ${seconds(handed.endedAt - handed.startedAt)}` : "";
      say(`  ${handed.id} ${handed.cause?.via ?? ""} ${BOLD}${handed.agentId}${RESET} ${tone(handed.status)}${DIM}${took}${RESET}  ${clip(oneLine(handed.prompt), 80)}`);
    }
  }

  if (audit.length > 0) {
    say();
    say(`${BOLD}audit${RESET}`);
    for (const entry of audit) say(`  ${DIM}${clock(entry.at)}${RESET} ${entry.action.padEnd(10)} ${entry.details ? summarize(entry.details, 80) : ""}`);
  }

  if (turn.reply) {
    say();
    say(`${BOLD}answer${RESET}`);
    say(turn.reply);
  }
}

function callLine(call: ModelCall, agentId: string): string {
  const who = call.agentId === agentId ? "" : `${call.agentId} `;
  // What it was for, when it was not the turn answering: a compaction, a reflection, a helper's or a peer's call.
  const what = call.purpose && call.purpose !== "turn" ? `${call.purpose.replace("_", " ")} ` : "";
  const cost = call.basis === "included" ? "included" : call.basis === "cli" ? "the CLI's own account" : call.usd === null ? "unpriced" : `$${call.usd.toFixed(4)}`;
  const estimate = call.estimated ? " (estimated)" : "";
  const latency = call.latencyMs === undefined ? "" : ` · ${seconds(call.latencyMs)}`;
  const attempts = call.attempts !== undefined && call.attempts > 1 ? ` · ${YELLOW}${call.attempts} attempts${RESET}` : "";
  return `${DIM}${clock(call.at)}${RESET} ${what}${who}${call.model}${servedBy(call)} ${DIM}${count(call.inputTokens)} in · ${count(call.outputTokens)} out${estimate} · ${cost}${latency}${RESET}${attempts}${stopped(call)}`;
}

/** One request's line: `#3 ~148,200 tokens · 2 results cleared · summary`, and where each newly cleared one was kept. */
function requestLine(line: NonNullable<TurnInspection["contexts"]>[number]): string {
  const who = line.by ? `${line.by} ` : "";
  const cleared = line.cleared > 0 ? ` · ${line.cleared} ${plural(line.cleared, "result")} cleared` : "";
  const kept = (line.keptAt ?? []).map((path) => `\n      ${DIM}kept at ${path}${RESET}`).join("");
  return `${DIM}#${line.request}${RESET} ${who}~${count(line.estimatedTokens)} tokens${cleared}${line.summary ? " · summary" : ""}${line.notes ? " · notes" : ""}${kept}`;
}

/**
 * Why the call ended, as the provider said (`stop_reason`): `max_tokens` — cut at the output limit — and `error` stand
 * out; nothing when it gave no reason, rather than a `stop` it never said.
 */
function stopped(call: Pick<ModelCall, "stopReason">): string {
  if (!call.stopReason) return "";
  return call.stopReason === "max_tokens" || call.stopReason === "error" ? ` · ${YELLOW}${call.stopReason}${RESET}` : ` ${DIM}· ${call.stopReason}${RESET}`;
}

/** Who answered, when a gateway said: the provider, the model when it is not the one asked for, and its tries. */
export function servedBy(call: Pick<ModelCall, "model" | "upstream">): string {
  const upstream = call.upstream;
  if (!upstream?.provider && !upstream?.model) return "";
  const model = upstream.model && upstream.model !== call.model ? ` ${upstream.model}` : "";
  const tries = upstream.attempts !== undefined && upstream.attempts > 1 ? `, ${YELLOW}${upstream.attempts} tried${RESET}${DIM}` : "";
  return ` ${DIM}via ${upstream.provider ?? "the gateway"}${model}${tries}${RESET}`;
}

function tone(status: string): string {
  return status === "done" ? status : `${YELLOW}${status}${RESET}`;
}

const count = (n: number) => n.toLocaleString("en-US");
const seconds = (ms: number) => (ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`);
const minute = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
const second = (at: number) => new Date(at).toISOString().slice(0, 19).replace("T", " ");
const clock = (at: number) => new Date(at).toISOString().slice(11, 19);
