/**
 * A command that follows a log or a screen and never exits on its own — refused in the background unless the call says
 * it is a service (`roadmap-backlog-small-items`).
 *
 * In the background a follower never ends. Its log keeps growing, so the watchdog never calls it quiet; it holds one of
 * the agent's job slots; and an update waits on it for as long as it runs, because `restartWhenIdle` waits on background
 * jobs however long they take and `[security] job_max_ms` is off by default — until somebody answers `now`. A follower
 * that is meant to run for good, a log shipper say, is a service, and `service: true` says so.
 *
 * Read by program, never by a flag anywhere in the line: `-f` is a file to `docker build`, `make` and `tar`, which are
 * exactly what goes to the background on purpose. `timeout 60 tail -f …` ends, and is let through.
 */

import { looseSegments } from "@nouride/policy";
import { SNAPSHOT_ADVICE } from "./exec-timeout.ts";

/** What runs a program on someone's behalf without bounding it — looked through to the program it runs. */
const WRAPPERS = new Set(["sudo", "doas", "nice", "nohup", "stdbuf", "env", "command", "exec"]);
/** Programs whose `logs` follows with `-f`: `docker logs -f`, `docker compose logs -f`, `kubectl logs -f`, `nouride logs -f`. */
const LOGS = new Set(["docker", "docker-compose", "podman", "kubectl", "oc", "nouride"]);

/** `-f`, `-F`, `--follow`, or a group of short flags with one of them in it — `-fu nginx`, `-ft`. */
function follows(word: string): boolean {
  if (word === "--follow" || (word.startsWith("--follow=") && word !== "--follow=false")) return true;
  return /^-[A-Za-z]+$/.test(word) && /[fF]/.test(word);
}

/** The follower a segment runs, as it is named back to the agent, or null. */
function followerOf(segment: readonly string[]): string | null {
  const at = segment.findIndex((word) => !WRAPPERS.has(base(word)) && !word.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (at < 0) return null;
  const program = base(segment[at]!);
  const rest = segment.slice(at + 1);
  if (program === "watch" || program === "stern") return `\`${program}\``;
  if ((program === "tail" || program === "journalctl") && rest.some(follows)) return `\`${program} -f\``;
  if (program === "less" && rest.includes("+F")) return "`less +F`";
  const logs = rest.indexOf("logs");
  if (LOGS.has(program) && logs >= 0 && rest.slice(logs + 1).some(follows)) return `\`${program} logs -f\``;
  return null;
}

/** The first follower in the command — a plain argv, or any segment of a `bash -lc` script — or null. */
export function followerIn(argv: string[]): string | null {
  for (const segment of looseSegments(argv)) {
    const found = followerOf(segment);
    if (found) return found;
  }
  return null;
}

/** What the agent is told instead of a job id. */
export function followerRefusal(follower: string): string {
  return (
    `Not started: ${follower} follows and never exits on its own, so in the background it would run until somebody ` +
    `stops it, holding a job slot and keeping a restart or an update waiting on it. ${SNAPSHOT_ADVICE} ` +
    "If it is meant to keep running for good (a log shipper, say), start it with `service: true`."
  );
}

function base(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}
