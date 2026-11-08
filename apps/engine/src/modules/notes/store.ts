/**
 * Work notes on disk: one markdown file per conversation, beside a small record of when each task was last written and
 * the plan that goes with it (0.7.26).
 *
 * Files rather than a table because they are text a person reads and edits — on the dashboard, or over ssh — and
 * because what they hold is working state, not the daemon's: not knowledge (the memory vault), not history (the
 * session). Not in the vault for the same reason: the nightly pass would file progress as fact.
 *
 * Every write goes through here, from the tool, the dashboard and `/notes clear` alike, so each gets the same checks: the
 * size cap and the credential scan.
 *
 *   data/notes/<agent>/<conversation>.md          the tasks
 *   data/notes/<agent>/<conversation>.json        when each was written, the plan, what was set aside
 *   data/notes/<agent>/<conversation>.prev.md     the file before the last clear, for a day
 *   data/notes/<agent>/<conversation>.archive.md  tasks set aside after two weeks untouched
 */

import { findSecrets } from "@nouride/secrets";
import { createLogger, formatBytes } from "@nouride/shared";
import {
  dirExists,
  fileExistsSync,
  join,
  listDir,
  readTextFileIfExists,
  readTextFileSync,
  removePath,
  sha256Text,
  statFile,
  writeTextFileAtomic,
} from "@nouride/runtime";
import type { StepState } from "@nouride/wire";
import { cleanBody, cleanTitle, NOTES_MAX_BYTES, notesBytes, parseNotes, renderNotes, sameTitle, withoutTask, withTask, type Task } from "./format.ts";

const log = createLogger("notes");

/** Whose notes: one agent, in one conversation. */
export interface NotesKey {
  agentId: string;
  gatewayId: string;
  chatId: string;
}

export interface PlanStep {
  text: string;
  state: StepState;
  /** Why a step was skipped — a plan that quietly loses step four is what `plan` exists to prevent. */
  reason?: string;
  /**
   * What a finished step did and left — files, ids, a count (0.8.0). A mission's next turn starts from its checklist and
   * not its history, so what a step produced is said here or nowhere.
   */
  note?: string;
}

/** The plan kept with a task, across turns (`plan`'s `task`). */
export interface KeptPlan {
  task: string;
  steps: PlanStep[];
  updatedAt: number;
}

interface Record_ {
  key: NotesKey;
  /** When each task was last written, by title. */
  written: Record<string, number>;
  plan?: KeptPlan;
  /** Tasks set aside, said once to the agent in the conversation — then dropped from here. */
  setAside?: { titles: string[]; at: number };
}

/** A write refused, in words the model — or a person on the dashboard — can act on. */
export class NotesRefused extends Error {
  override name = "NotesRefused";
}

/** Untouched this long, a task is set aside. */
export const STALE_AFTER_MS = 14 * 24 * 60 * 60_000;
/** How long the file before a clear is kept. */
const PREV_KEPT_MS = 24 * 60 * 60_000;

/**
 * A path segment from an id the daemon did not choose — a chat id is whatever the platform hands over — with a short
 * hash of the id, so two ids that clean to the same text stay two files.
 */
function segment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_").slice(0, 80) || "x";
  return `${cleaned}-${sha256Text(id).slice(0, 8)}`;
}

export class NotesStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private base(key: NotesKey): string {
    return join(this.dir, segment(key.agentId), segment(`${key.gatewayId}\u0000${key.chatId}`));
  }

  /** One agent's notes, every conversation's — readable to its turns, for the archive their notes point at. */
  folderOf(agentId: string): string {
    return join(this.dir, segment(agentId));
  }

  /** Where this conversation's notes are — for the dashboard and the agent, which may read the archive. */
  pathOf(key: NotesKey): { notes: string; archive: string } {
    const base = this.base(key);
    return { notes: `${base}.md`, archive: `${base}.archive.md` };
  }

  /** The tasks, in order. None when there is no file — or one that cannot be read, which is logged. */
  tasks(key: NotesKey): Task[] {
    const path = `${this.base(key)}.md`;
    if (!fileExistsSync(path)) return [];
    try {
      return parseNotes(readTextFileSync(path));
    } catch (err) {
      log.warn("work notes could not be read", { agent_id: key.agentId, chat_id: key.chatId, error: String(err) });
      return [];
    }
  }

  private record(key: NotesKey): Record_ {
    const path = `${this.base(key)}.json`;
    if (fileExistsSync(path)) {
      try {
        const read = JSON.parse(readTextFileSync(path)) as Partial<Record_>;
        return { key, written: read.written ?? {}, ...(read.plan ? { plan: read.plan } : {}), ...(read.setAside ? { setAside: read.setAside } : {}) };
      } catch (err) {
        log.warn("work notes' record could not be read, so it is taken as empty", { agent_id: key.agentId, chat_id: key.chatId, error: String(err) });
      }
    }
    return { key, written: {} };
  }

  private async save(key: NotesKey, tasks: readonly Task[], record: Record_): Promise<void> {
    const base = this.base(key);
    if (tasks.length === 0) removePath(`${base}.md`);
    else await writeTextFileAtomic(`${base}.md`, renderNotes(tasks));
    if (Object.keys(record.written).length === 0 && !record.plan && !record.setAside) removePath(`${base}.json`);
    else await writeTextFileAtomic(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`);
  }

  /** What would make a write unsafe or too big to send at every step, said so it can be fixed. */
  private check(tasks: readonly Task[]): void {
    const bytes = notesBytes(tasks);
    if (bytes > NOTES_MAX_BYTES) {
      // Each task's share, so what to merge or condense is read here rather than found by viewing the whole file.
      const shares = tasks.map((task) => `"${task.title}" ${formatBytes(notesBytes([task]))}`).join(", ");
      throw new NotesRefused(
        `The notes would be ${bytes} bytes; they hold ${NOTES_MAX_BYTES} (${shares}). One piece of work is one task: merge ` +
          "the sections that are one, condense what is finished (results in a line, steps done as a range), or remove a " +
          "task that is over.",
      );
    }
    const secret = tasks.flatMap((task) => findSecrets(`${task.title}\n${task.body}`, "eager"))[0];
    if (secret) {
      throw new NotesRefused(
        `That holds what looks like a credential (${secret.pattern.label}). Notes are sent to the model at every step and ` +
          "shown on the dashboard: write the secret's name, or its $TMP_SECRET_ handle, never its value.",
      );
    }
  }

  /** Create or replace one task. Returns whether it was new. */
  async write(key: NotesKey, title: string, body: string): Promise<{ created: boolean }> {
    const name = cleanTitle(title);
    if (!name) throw new NotesRefused("A task needs a title: what the work is, in a few words.");
    const before = this.tasks(key);
    const created = !before.some((task) => sameTitle(task.title, name));
    const tasks = withTask(before, name, cleanBody(body));
    this.check(tasks);
    const record = this.record(key);
    record.written = Object.fromEntries(Object.entries(record.written).filter(([title]) => !sameTitle(title, name)));
    record.written[name] = this.now();
    await this.save(key, tasks, record);
    return { created };
  }

  /** Remove one task — and its plan with it. Returns what was removed, or null when there was no such task. */
  async remove(key: NotesKey, title: string): Promise<Task | null> {
    const { tasks, removed } = withoutTask(this.tasks(key), title);
    if (!removed) return null;
    const record = this.record(key);
    record.written = Object.fromEntries(Object.entries(record.written).filter(([name]) => !sameTitle(name, removed.title)));
    if (record.plan && sameTitle(record.plan.task, removed.title)) delete record.plan;
    await this.save(key, tasks, record);
    return removed;
  }

  /**
   * The whole file, as a person edited it on the dashboard: parsed into tasks and checked like any write. A task whose
   * words did not change keeps when it was written; the rest are written now.
   */
  async replace(key: NotesKey, text: string): Promise<Task[]> {
    const before = this.tasks(key);
    const tasks = parseNotes(text).map((task) => ({ title: cleanTitle(task.title), body: cleanBody(task.body) })).filter((task) => task.title);
    this.check(tasks);
    const record = this.record(key);
    const written: Record<string, number> = {};
    for (const task of tasks) {
      const same = before.find((old) => sameTitle(old.title, task.title) && old.body === task.body);
      const at = same ? Object.entries(record.written).find(([name]) => sameTitle(name, task.title))?.[1] : undefined;
      written[task.title] = at ?? this.now();
    }
    record.written = written;
    if (record.plan && !tasks.some((task) => sameTitle(task.title, record.plan!.task))) delete record.plan;
    await this.save(key, tasks, record);
    return tasks;
  }

  /**
   * Empty them — `/reset`, `/notes clear`, a deleted conversation. The file before is kept a day, unless `keep` is false:
   * a conversation deleted on purpose leaves nothing of itself behind. Returns how many tasks went.
   */
  async clear(key: NotesKey, options: { keep?: boolean } = {}): Promise<number> {
    const base = this.base(key);
    const tasks = this.tasks(key);
    const record = this.record(key);
    if (options.keep === false) removePath(`${base}.prev.md`);
    if (tasks.length === 0 && !record.plan) return 0;
    if (tasks.length > 0 && options.keep !== false) await writeTextFileAtomic(`${base}.prev.md`, renderNotes(tasks));
    removePath(`${base}.md`);
    removePath(`${base}.json`);
    return tasks.length;
  }

  /** The plan kept with a task, when there is one. */
  plan(key: NotesKey): KeptPlan | undefined {
    return this.record(key).plan;
  }

  /**
   * Keep a plan with its task. The task is made — an empty section — when the notes have none of that name: a plan for
   * work the notes do not mention would be steps with no goal beside them.
   */
  async keepPlan(key: NotesKey, task: string, steps: readonly PlanStep[]): Promise<void> {
    const name = cleanTitle(task) || "Current work";
    const tasks = this.tasks(key);
    const existing = tasks.find((one) => sameTitle(one.title, name));
    const next = existing ? tasks : withTask(tasks, name, "");
    this.check(next);
    const record = this.record(key);
    record.plan = { task: existing?.title ?? name, steps: [...steps], updatedAt: this.now() };
    if (!existing) record.written[name] = this.now();
    await this.save(key, next, record);
  }

  /** Drop the kept plan. */
  async dropPlan(key: NotesKey): Promise<void> {
    const record = this.record(key);
    if (!record.plan) return;
    delete record.plan;
    await this.save(key, this.tasks(key), record);
  }

  /** The task written last — where a plan with no `task` goes, and what a helper is handed. */
  latest(key: NotesKey): Task | undefined {
    const tasks = this.tasks(key);
    const written = this.record(key).written;
    const when = (task: Task) => Object.entries(written).find(([name]) => sameTitle(name, task.title))?.[1] ?? 0;
    // Ties — two writes in one millisecond — go to the one further down, which was added later.
    return tasks.map((task, index) => ({ task, index })).sort((a, b) => when(b.task) - when(a.task) || b.index - a.index)[0]?.task;
  }

  /** When a task was last written, by title — undefined for one no write is recorded for. */
  writtenAt(key: NotesKey, title: string): number | undefined {
    return Object.entries(this.record(key).written).find(([name]) => sameTitle(name, title))?.[1];
  }

  /** One task, by title. */
  task(key: NotesKey, title: string): Task | undefined {
    return this.tasks(key).find((task) => sameTitle(task.title, title));
  }

  /** Titles set aside since the agent was last told, and when — said once, then forgotten (`acknowledge`). */
  setAside(key: NotesKey): { titles: string[]; at: number } | undefined {
    return this.record(key).setAside;
  }

  /** The agent has been told what was set aside. */
  async acknowledge(key: NotesKey): Promise<void> {
    const record = this.record(key);
    if (!record.setAside) return;
    delete record.setAside;
    await this.save(key, this.tasks(key), record);
  }

  /**
   * Set aside every task nobody has written for two weeks, in every conversation: moved to the archive beside the notes,
   * with the date, so the notes stay what is being worked on. The agent is told in its next turn there. And the file
   * kept before a clear goes after a day. Returns how many tasks were set aside.
   */
  async sweep(now: number = this.now()): Promise<number> {
    if (!dirExists(this.dir)) return 0;
    let moved = 0;
    for (const agent of listDir(this.dir).filter((entry) => entry.isDirectory)) {
      const folder = join(this.dir, agent.name);
      for (const entry of listDir(folder)) {
        const path = join(folder, entry.name);
        if (entry.name.endsWith(".prev.md")) {
          const stat = statFile(path);
          if (stat && now - stat.mtimeMs > PREV_KEPT_MS) removePath(path);
          continue;
        }
        if (!entry.name.endsWith(".json")) continue;
        try {
          const record = JSON.parse(readTextFileSync(path)) as Record_;
          moved += await this.setAsideStale(record.key, now);
        } catch (err) {
          log.warn("work notes could not be swept", { file: entry.name, error: String(err) });
        }
      }
    }
    if (moved) log.info("work notes set aside after two weeks untouched", { tasks: moved });
    return moved;
  }

  private async setAsideStale(key: NotesKey, now: number): Promise<number> {
    const record = this.record(key);
    const tasks = this.tasks(key);
    const writtenAt = (task: Task) => Object.entries(record.written).find(([name]) => sameTitle(name, task.title))?.[1] ?? now;
    const stale = tasks.filter((task) => now - writtenAt(task) >= STALE_AFTER_MS);
    if (stale.length === 0) return 0;
    const day = new Date(now).toISOString().slice(0, 10);
    const archive = `${this.base(key)}.archive.md`;
    const before = (await readTextFileIfExists(archive)) ?? "";
    await writeTextFileAtomic(archive, before + stale.map((task) => `## ${task.title} (set aside ${day})\n\n${task.body}\n\n`).join(""));
    const kept = tasks.filter((task) => !stale.includes(task));
    record.written = Object.fromEntries(Object.entries(record.written).filter(([name]) => kept.some((task) => sameTitle(task.title, name))));
    if (record.plan && !kept.some((task) => sameTitle(task.title, record.plan!.task))) delete record.plan;
    record.setAside = { titles: [...(record.setAside?.titles ?? []), ...stale.map((task) => task.title)], at: now };
    await this.save(key, kept, record);
    return stale.length;
  }
}

export type NotesPort = Pick<
  NotesStore,
  "tasks" | "write" | "remove" | "replace" | "clear" | "plan" | "keepPlan" | "dropPlan" | "latest" | "task" | "writtenAt" | "setAside" | "acknowledge" | "pathOf" | "folderOf"
>;
