/**
 * The decision: run, ask, or refuse.
 *
 * One pure function, no I/O, no database, no daemon. Everything that decides whether a command
 * runs on the operator's machine is in one place that a test can drive exhaustively — the
 * previous shape spread the same decision across the exec tool's `approvalPolicy`, the agent's
 * `approval_required` list, and the gate, and no single test could tell you what would happen.
 *
 * What this decides is whether a command is a *question*; whether the question reaches a person is the approval
 * level's (`approvals.ts`), read by the executor afterwards. Order matters and is not arbitrary:
 *
 *   1. `blocked`     — the operator's own veto. Beats a grant and every level: if this were not
 *                      first, `allow-always` could outvote the config file.
 *   2. the fixed list — asked every time and never grantable (`classifyHardline`, and the daemon's
 *                      own state where no file permission stands in front of it).
 *   3. grant         — the human already answered this exact command.
 *   4. everyday      — a program on `EVERYDAY_PROGRAMS`, touching no credential path, runs.
 *   5. anything else — asked once; `allow-always` remembers it.
 *
 * Everything that must beat a grant sits above it, and that is the whole reason for the ordering. The first draft had
 * the grant lookup above an "ask every time" setting, so an operator who tightened it kept silently inheriting every
 * grant made while it was loose — the test table caught it, which is the argument for a table.
 *
 * Until 0.8.0 four knobs sat in this order too — `mode`, `ask`, `ask_fallback`, `sensitive_paths` — each a guess at
 * which command is dangerous, and the project's own box ran with all of them open. The levels and the fixed list say the
 * same things once; where each agent runs as its own user, the operating system says the rest.
 */

import { classifyHardline, classifyOwnState, credentialPath } from "./hardline.ts";
import { launchedScript, programName, scriptSegments } from "./shell-segments.ts";
import type { ExecGrant, ExecPolicy, ExecRequest, PolicyAsk, PolicyOutcome } from "./types.ts";

export interface DecideInput {
  policy: ExecPolicy;
  request: ExecRequest;
  /** Precomputed by the caller — see `execGrantKey`. */
  grantKey: string;
  /** Grants held for this agent. A `Set` of keys is enough; the text is for display only. */
  grants: ReadonlySet<string> | readonly ExecGrant[];
  /**
   * Whether a human can be reached right now.
   *
   * False when no gateway is connected, or the request came from a surface with nobody watching. What would ask is
   * then refused, carrying its question, so a level that answers it by itself still can.
   */
  canAsk: boolean;
  /**
   * Whether the command runs as the agent's own user (0.8.0's isolation), so the daemon's database, its config and the
   * other agents' packs are closed to it by file permissions. Then nothing here guesses at those paths: the command is
   * refused by the operating system, not asked about. False where agents run as the daemon — Docker, macOS, an install
   * without the helper — and for the `nouride` tool, which runs as the daemon by design.
   */
  ownStateByOs: boolean;
}

/**
 * Programs where every invocation is harmless, so asking is pure friction. Fixed since 0.8.0 — it was a key nobody
 * tuned. Deliberately excluded, and worth knowing why:
 *   env, printenv — print the process environment, which holds every provider key
 *   find, xargs   — `-delete` and `-exec` make them arbitrary-mutation tools
 *   sed, awk      — `-i` rewrites in place, `system()` shells out
 *   git           — `status` is safe, `push --force` is not, and this list cannot tell them
 *                   apart; a durable grant on the exact command is the right tool for git
 */
export const EVERYDAY_PROGRAMS: readonly string[] = [
  "ls", "pwd", "cat", "head", "tail", "wc", "date", "echo", "which", "file", "stat",
  "grep", "rg", "tree", "df", "du", "uname", "whoami", "basename", "dirname",
];

function hasGrant(grants: DecideInput["grants"], key: string): boolean {
  // Discriminated on `has` rather than `Array.isArray`: the latter narrows its true branch but
  // leaves the false branch as the union when the array member is `readonly`. Both shapes are
  // accepted because the daemon holds a Set of keys while a test reads better as a list of grants.
  return "has" in grants ? grants.has(key) : grants.some((grant) => grant.key === key);
}

function matchesBlocked(argv: readonly string[], blocked: readonly string[]): string | null {
  if (blocked.length === 0) return null;
  const program = programName(argv[0] ?? "");
  const joined = argv.join(" ");
  return blocked.find((pattern) => program === pattern || joined.includes(pattern)) ?? null;
}

/**
 * An everyday program, by name, arguments ignored.
 *
 * A shell launcher (`bash -lc "ls -la && wc -l x"`) counts when every segment of its script
 * runs one — otherwise a chain asks where the same steps sent one per turn would
 * not, and that is the incentive that produced one-command-per-turn. `scriptSegments` returns
 * `null` for anything it cannot read with certainty, and then only `argv[0]` counts, as before.
 */
function everyday(argv: readonly string[]): boolean {
  if (EVERYDAY_PROGRAMS.includes(programName(argv[0] ?? ""))) return true;
  const script = launchedScript(argv);
  if (script === null) return false;
  const segments = scriptSegments(script);
  return segments !== null && segments.every((words) => EVERYDAY_PROGRAMS.includes(programName(words[0]!)));
}

export function decideExec(input: DecideInput): PolicyOutcome {
  const { policy, request, grantKey, grants, canAsk } = input;
  const argv = request.argv;

  if (argv.length === 0 || !argv[0]) {
    return { action: "refuse", reason: "no command given" };
  }

  const blocked = matchesBlocked(argv, policy.blocked);
  if (blocked) {
    return {
      action: "refuse",
      reason: `blocked by this agent's configuration: "${blocked}"`,
    };
  }

  // The fixed list: above the grant lookup, which is exactly what never-grantable means. `classifyHardline` is asked
  // first so a command that is both — `rm -rf` of a pack — is reported by what it does rather than what it touches.
  const listed = classifyHardline(argv) ?? (input.ownStateByOs ? null : classifyOwnState(argv, request.cwd));
  if (listed) {
    return askOr(canAsk, {
      action: "ask",
      grantable: false,
      hardline: true,
      // The class travels with the decision: it is what the approval level reads to decide whether it asks.
      hardlineClass: listed.class,
      reason: listed.reason,
    }, () => ({ action: "refuse", reason: `needs approval (${listed.reason}) and there is nobody to ask right now` }));
  }

  if (hasGrant(grants, grantKey)) {
    return { action: "run", via: "grant" };
  }

  /**
   * A credential path is never "everyday", whatever reads it.
   *
   * `cat` is on the list, and `cat ~/.ssh/id_ed25519` is the one read that puts a key into the conversation for good.
   * So it is a command like any new one: `careful` asks once and `allow-always` remembers that exact command, while
   * `balanced` and `trusted` run it — with the output masked either way (`credential-files.ts`).
   */
  const credential = credentialPath(argv);
  if (credential === null && everyday(argv)) return { action: "run", via: "allowlist" };

  const why = credential === null ? "first time this agent has run this command" : `touches credentials (${credential})`;
  return askOr(
    canAsk,
    { action: "ask", grantable: true, reason: why },
    () => ({ action: "refuse", reason: `${why}, and there is nobody to ask right now` }),
  );
}

/**
 * The question when somebody could answer it; otherwise a refusal carrying the question it stands in for.
 *
 * "Nobody to ask" was a refusal and nothing more, so an agent set to never ask had its `sudo` refused
 * whenever every chat was disconnected and no dashboard was open, though nobody would have been asked
 * either way. With the question attached, the approval level gets to answer it first (`ToolCaller`).
 */
function askOr(canAsk: boolean, ask: PolicyAsk, fallback: () => PolicyOutcome): PolicyOutcome {
  if (canAsk) return ask;
  const instead = fallback();
  return instead.action === "refuse" ? { ...instead, unasked: ask } : instead;
}

/**
 * What a human's answer means, once the policy has already said "ask".
 *
 * Split out because the downgrade rule is easy to get wrong at the call site: a `grantable:
 * false` ask that receives `allow-always` must run *and not persist*, rather than being
 * rejected — refusing the answer would strand a turn on a technicality the operator cannot see.
 */
export function resolveDecision(
  decision: "allow-once" | "allow-always" | "deny",
  grantable: boolean,
): { run: boolean; persist: boolean; downgraded: boolean } {
  if (decision === "deny") return { run: false, persist: false, downgraded: false };
  const persist = decision === "allow-always" && grantable;
  return {
    run: true,
    persist,
    downgraded: decision === "allow-always" && !grantable,
  };
}
