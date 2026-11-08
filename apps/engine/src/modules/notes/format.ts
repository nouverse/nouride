/**
 * A conversation's work notes as text: a section per task, `## <title>` and what the agent wrote under it.
 *
 * Pure, so what a write does to the file is testable without one. The headings inside a task — Goal, Done, Next,
 * Rules, Facts, Waiting on — are a convention the tool's description teaches, not a schema read here: a task is its
 * title and its words.
 */

import { oneLine } from "@nouride/shared";

export interface Task {
  title: string;
  body: string;
}

/** Bytes the notes file may hold — about two thousand tokens, sent at every step of every turn in the conversation. */
export const NOTES_MAX_BYTES = 8 * 1024;

/** The longest title: a task is named in a line, not described in one. */
const TITLE_MAX = 120;

const HEADING = /^## (.*)$/;

/** The tasks a notes file holds, in its order. Text before the first heading is kept as a task without a title. */
export function parseNotes(text: string): Task[] {
  const tasks: Task[] = [];
  let current: { title: string; lines: string[] } | null = null;
  const loose: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      if (current) tasks.push(finish(current));
      current = { title: heading[1]!.trim(), lines: [] };
    } else if (current) current.lines.push(line);
    else loose.push(line);
  }
  if (current) tasks.push(finish(current));
  const before = loose.join("\n").trim();
  return before ? [{ title: "Notes", body: before }, ...tasks] : tasks;
}

function finish(task: { title: string; lines: string[] }): Task {
  return { title: task.title, body: task.lines.join("\n").trim() };
}

/** The file for these tasks. */
export function renderNotes(tasks: readonly Task[]): string {
  return tasks.map((task) => `## ${task.title}\n\n${task.body}\n`).join("\n");
}

/** A title as it is matched: case and spacing do not make two tasks. */
export function sameTitle(a: string, b: string): boolean {
  return oneLine(a).toLowerCase() === oneLine(b).toLowerCase();
}

/**
 * A task's words as they go into the file. A `## ` line inside them would start a task of its own when the file is read
 * back, so it becomes a `### `; a `# ` line likewise.
 */
export function cleanBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (/^#{1,2} /.test(line) ? `###${line.replace(/^#+/, "")}` : line))
    .join("\n")
    .trim();
}

/** A title as it goes into the file: one line, no heading marks, at most {@link TITLE_MAX} characters. */
export function cleanTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").replace(/^#+\s*/, "").trim().slice(0, TITLE_MAX);
}

/** The tasks with `title` written: replaced where it is, or added at the end. */
export function withTask(tasks: readonly Task[], title: string, body: string): Task[] {
  const at = tasks.findIndex((task) => sameTitle(task.title, title));
  if (at < 0) return [...tasks, { title, body }];
  return tasks.map((task, index) => (index === at ? { title: task.title, body } : task));
}

/** The tasks without `title`, and the one taken out, if there was one. */
export function withoutTask(tasks: readonly Task[], title: string): { tasks: Task[]; removed: Task | null } {
  const at = tasks.findIndex((task) => sameTitle(task.title, title));
  if (at < 0) return { tasks: [...tasks], removed: null };
  return { tasks: tasks.filter((_, index) => index !== at), removed: tasks[at]! };
}

/** Bytes as the file holds them. */
export function notesBytes(tasks: readonly Task[]): number {
  return new TextEncoder().encode(renderNotes(tasks)).length;
}
