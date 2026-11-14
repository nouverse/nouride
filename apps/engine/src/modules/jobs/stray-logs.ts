/**
 * The job logs no job's row names.
 *
 * The sweep of old logs goes by the rows: a row whose log has aged loses both. A log with no row is never looked at
 * by it, and so stayed for good: the ones a build wrote straight into the folder before each agent had a folder of its
 * own there, and any whose row went another way. A live install held thirty-six of them, the oldest three months old.
 */

import { join, listDir, statFile } from "@nouride/runtime";

/** A job's log, by the id it is named for. */
const LOG = /^(job_[0-9a-f]+)\.log$/;

/**
 * Each job log last written before `cutoff` whose job `known` does not hold: in the folder itself, and in each agent's
 * folder in it. Only a file named as a job's log is one, and a link never is: an agent's folder here also holds what
 * the daemon stages for it.
 */
export function strayLogs(logDir: string, known: (jobId: string) => boolean, cutoff: number): string[] {
  const stray: string[] = [];
  const look = (dir: string) => {
    for (const entry of listDir(dir)) {
      const id = LOG.exec(entry.name)?.[1];
      if (!entry.isFile || !id || known(id)) continue;
      const stat = statFile(join(dir, entry.name));
      if (stat && stat.mtimeMs < cutoff) stray.push(join(dir, entry.name));
    }
  };
  look(logDir);
  for (const agent of listDir(logDir)) if (agent.isDirectory) look(join(logDir, agent.name));
  return stray;
}
