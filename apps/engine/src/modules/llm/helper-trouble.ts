/**
 * What went wrong with the helper models' work in the last day, read back from the daemon's own log — for `/health`,
 * whose issues the Overview lists, and for `nouride doctor`.
 *
 * A compaction that failed and a memory pass that could not ask its model were each one `warn` in the journal. On the
 * box they failed all afternoon (2026-10-21) — a pass model that went away — and nothing an operator looks at said so.
 * The lines are already stored (`log_entries`, kept `[retention] log_days`), so this reads them rather than keeping a
 * count of its own: a restart keeps what the day did, and there is no second table to sweep.
 */

import { isModelTier, type GlobalConfig, type InstallTiers } from "@nouride/shared";
import type { LogsPort, StoredLog } from "@/commons/logs.store.ts";
import { HELPER_ANSWERED, shorten } from "./helper-model.ts";
import type { HelperJob } from "@nouride/wire";

/** What `summarize.ts` says when a summary did not come back — the fallback's too, when it had one. */
export const COMPACTION_FAILED = "could not summarize history, keeping it as it was";
/**
 * What finds it in the log: the words before the dash 0.8.15 and older wrote ("…history — keeping it…"), so a failure
 * logged before an upgrade still counts for the day after it.
 */
const COMPACTION_FAILED_SEARCH = "could not summarize history";
/** What `boot/memory-pass.ts` says when the pass's model could not be asked. */
export const PASS_CALL_FAILED = "memory pass call failed";

const DAY_MS = 24 * 60 * 60_000;

type Job = HelperJob;

/** A number in a log line's data, or 0. */
const num = (data: Record<string, unknown> | undefined, key: string): number => (typeof data?.[key] === "number" ? (data[key] as number) : 0);

/**
 * The lines read, by the component that writes them. `llm.helper` writes two, the fallback and the helper answering
 * again (`helper-model.ts`). `recovered` is what says a job worked again, read from its own success line — which is
 * written in more cases than a model answering: a compaction that only pruned tool output never asked one, and a pass
 * whose every call failed still says it is done.
 */
const WATCHED: readonly {
  job: Job;
  component: string;
  search?: string;
  recovered?: { search: string; worked: (data: Record<string, unknown> | undefined, failed: Record<string, unknown> | undefined) => boolean };
}[] = [
  { job: "compaction", component: "llm.summarize", search: COMPACTION_FAILED_SEARCH, recovered: { search: "history compacted", worked: (data) => num(data, "turns") > 0 } },
  // Something filed: only a model that answered files a conversation. A pass whose calls all failed is "done" too,
  // with nothing filed — and with nothing counted as waiting, since a model it could not reach is not an attempt.
  { job: "memory pass", component: "memory.pass", search: PASS_CALL_FAILED, recovered: { search: "memory pass done", worked: (data) => num(data, "filed") > 0 } },
  {
    job: "fallback",
    component: "llm.helper",
    recovered: { search: HELPER_ANSWERED, worked: (data, failed) => data?.helper_model === failed?.helper_model && data?.helper_profile === failed?.helper_profile },
  },
];

export interface HelperTrouble {
  /** `compaction` and `memory pass` failed; `fallback` is a helper model the agent's own stood in for. */
  job: Job;
  /** Lines in the last 24 h. A fallback is said once an hour per helper, so for it this counts hours. */
  count: number;
  /** The model the last one was asked of. */
  model: string;
  /**
   * The last one's error, shortened — the provider's own words. For the operator (`/status`, doctor), never `/health`:
   * anybody who reaches the port reads that.
   */
  last: string;
  at: number;
  /** What to change. */
  fix: string;
  /** The line `/health` says: no count and no provider text, so the same trouble reads the same on every request. */
  issue: string;
  /** The line doctor says, with the count. */
  summary: string;
}

type Settings = {
  memory: Pick<GlobalConfig["memory"], "passModel">;
  llm: { context: Pick<GlobalConfig["llm"]["context"], "summaryModel">; /** For a key that names a tier (0.8.0). */ defaults?: InstallTiers };
};

/**
 * Whether `setting` sends a helper to `model`: written as that model, or as a tier (0.8.0) — whose model is the install's
 * for that tier when it names one, and otherwise each agent's own, which this cannot see, so it may be this one.
 */
function routes(setting: string | undefined, model: string, config: Settings): boolean {
  if (!setting || !model) return false;
  if (setting === model) return true;
  if (!isModelTier(setting) || setting === "default") return false;
  const installs = setting === "small" ? config.llm.defaults?.smallModel : config.llm.defaults?.highModel;
  return !installs || installs === model;
}

/** Each helper's trouble in the 24 h before `now`, or nothing — the newest line of each kind, and how many there were. */
export function helperTrouble(logs: Pick<LogsPort, "query" | "count">, config: Settings, now: number): HelperTrouble[] {
  const found: HelperTrouble[] = [];
  for (const watched of WATCHED) {
    const query = { component: watched.component, minLevel: "warn" as const, since: now - DAY_MS, ...(watched.search ? { search: watched.search } : {}) };
    const [last] = logs.query({ ...query, limit: 1 });
    if (!last || recovered(logs, watched, last, config)) continue;
    found.push(describe(watched.job, last, logs.count(query), config));
  }
  return found;
}

/**
 * Whether the trouble is over: the job has worked since its last failure, or — for a fallback — the helper model it
 * stood in for has answered since, or is no longer the one the settings name. Live (2026-10-21): after `pass_model` was changed and the pass had
 * filed everything, the Overview still listed all three failures for a day, and blamed the new model for the old one's.
 */
function recovered(logs: Pick<LogsPort, "query">, watched: (typeof WATCHED)[number], last: StoredLog, config: Settings): boolean {
  if (watched.recovered) {
    // By id, because a success and a failure can share a millisecond.
    const lines = logs.query({ component: watched.component, search: watched.recovered.search, since: last.ts, limit: 50 });
    if (lines.some((line) => line.id > last.id && watched.recovered!.worked(line.data, last.data))) return true;
  }
  if (watched.job !== "fallback") return false;
  const helper = typeof last.data?.helper_model === "string" ? last.data.helper_model : "";
  return helper !== "" && !routes(config.memory.passModel, helper, config) && !routes(config.llm.context.summaryModel, helper, config);
}

function describe(job: Job, line: StoredLog, count: number, config: Settings): HelperTrouble {
  const data = line.data ?? {};
  const text = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : "");
  // The bare model is what the config names; the profile, where the line has it, is what the operator reads.
  const logged = job === "fallback" ? text("helper_model") : text("model");
  const profile = job === "fallback" ? text("helper_profile") : text("provider");
  // A line from before the model was logged names none. Then it was the model today's settings route the job to —
  // not "the agent's own", which sent the operator looking at the wrong setting (live: it was `pass_model`).
  const routed = job === "memory pass" ? config.memory.passModel : job === "compaction" ? config.llm.context.summaryModel || config.memory.passModel : undefined;
  const bare = logged || routed || "";
  const model = logged ? (profile ? `${profile}/${logged}` : logged) : routed ? `${routed} (probably: the line does not name it)` : "the agent's own model";
  const fix = fixFor(bare, job, config);
  const times = `${count} time(s) in the last 24 h`;
  const said = {
    compaction: { issue: `compaction failed in the last 24 h on ${model}, so conversations were not compacted`, summary: `compaction failed ${times}, the last on ${model}` },
    "memory pass": { issue: `memory pass: ${model} could not be asked in the last 24 h, so conversations wait unfiled`, summary: `memory pass: its model could not be asked ${times}, the last was ${model}` },
    fallback: { issue: `helper model ${model} could not answer in the last 24 h, so the agents' own model stood in`, summary: `helper model ${model} could not answer in ${count} hour(s) of the last 24, so the agents' own model stood in` },
  }[job];
  // `String(err)` leads with the class name; the provider's words are what is worth the room.
  const last = shorten(text(job === "fallback" ? "reason" : "error").replace(/^LLMError: /, ""), 240);
  return { job, count, model, last, at: line.ts, fix, issue: `${said.issue}; ${fix}`, summary: said.summary };
}

/** What to change, by which setting chose the model — and nothing to change once neither names it any more. */
function fixFor(model: string, job: Job, config: Settings): string {
  const tier = (key: string, setting: string) =>
    `${key} = "${setting}" reaches it as the ${setting} tier: set the ${setting} model ([llm.defaults] ${setting}_model, or an agent's own) to one that answers, or ${key.split(" ").pop()} to another`;
  if (isModelTier(config.memory.passModel) && routes(config.memory.passModel, model, config)) return tier("[memory] pass_model", config.memory.passModel);
  if (isModelTier(config.llm.context.summaryModel) && routes(config.llm.context.summaryModel, model, config)) return tier("[llm.context] summary_model", config.llm.context.summaryModel);
  if (model && model === config.memory.passModel) return "set [memory] pass_model to a model that answers, or remove it to use each agent's own (`nouride memory set pass_model -`)";
  if (model && model === config.llm.context.summaryModel) return "set [llm.context] summary_model to a model the agents' profile serves, or remove it to use each agent's own";
  if (job === "fallback") return "no setting names it now, so this clears 24 h after the last";
  return "the agent's own model failed here: `nouride logs --component " + (job === "compaction" ? "llm.summarize" : "memory.pass") + "` says why";
}
