/**
 * How much gets asked, and who decides.
 *
 * Replaces a boolean. `/auto on|off` could only say "stop asking me" or "ask me", and the two things
 * people actually want sit either side of that: an operator on their own homelab wants nothing asked,
 * and a shared room wants the policy honoured. One flag could not express both.
 *
 * ## The three levels (0.8.0: the presets, over one fixed list)
 *
 * - **`careful`** — a new command or a mutating tool asks once, and `allow-always` remembers it; everything on the
 *   fixed list (`HardlineClass`) asks every time. What a new install writes.
 * - **`balanced`** — only `BALANCED_ASKS`: a `config.toml` changed, someone given access, the daemon stopped, a
 *   stored secret replaced or deleted, a credential leaving, this machine's system packages changed (0.8.15), the
 *   daemon's own state where agents run as it, and what `trusted` asks too. The default in the code, and the owner's
 *   everyday level.
 * - **`trusted`** — only `NEVER_SKIPPED`: work nobody watches sending elsewhere, a program installed for every agent,
 *   an agent's own persona, and who People says a person is.
 *
 * ## Who decides, and why the order is this way round
 *
 * An agent's level wins when it states one, because an agent is a shared surface: several people talk
 * to the same one, and a posture that changed depending on who spoke would be a posture nobody could
 * reason about. `per-person` is how an agent declines to decide, and it is the default — which keeps
 * the behaviour that already existed, where each person's own "stop asking me" followed them around.
 *
 * A person cannot loosen an agent, and in this version cannot tighten one either. Letting them tighten
 * is safe and was considered; it is one more rule to hold in your head for a case nobody has hit yet,
 * so it is deliberately left out rather than half-built.
 *
 * ## Why `trusted` is not settable from a chat message
 *
 * A chat sender is not authenticated. That is the entire reason pairing exists: knowing the bot's
 * username is not proof of anything. So a `/approvals trusted` typed in Discord would hand every member
 * of that server one command to disarm the daemon.
 *
 * The CLI is not a safe home for it either, and that is not a theoretical worry — the agent holds the
 * `nouride` tool, and this repo's own notes record that `classifyHardline` returns nothing for
 * `nouride config set security.exec.ask off` (exit 2 now, a verb gone). An agent at `balanced` could therefore be talked into
 * loosening its own gate with no approval. So there is **no CLI verb that writes this**, only ones that
 * read it: the write paths are the dashboard, which requires a login, and editing `config.toml` by
 * hand, which is on the fixed list (`config`) and asked at `balanced` too.
 */

// The vocabulary — the levels and their guards — lives in `shared`: `AgentConfig` needs the types and `shared` imports
// nothing, so every caller takes them from there. This file holds the rules.
import { type AgentApprovalLevel, type ApprovalLevel, type HardlineClass } from "@nouride/shared";
import { autoApprovable } from "./hardline.ts";

export interface ApprovalResolution {
  level: ApprovalLevel;
  /** Which layer decided, so the UI and the audit log can say why rather than just what. */
  source: "agent" | "person" | "daemon";
}

/**
 * Resolve the level for one (agent, person) pair.
 *
 * Pure, and the three inputs are the three places a level can live. The caller reads them; this
 * decides. Keeping the decision here rather than in the executor is what makes "why am I being asked"
 * answerable from a test instead of from a stack trace.
 */
export function resolveApprovalLevel(input: {
  /** `[agent] approvals` from the pack. `per-person` or absent defers. */
  agent?: AgentApprovalLevel | undefined;
  /** What this person set for themselves, if anything. */
  person?: ApprovalLevel | undefined;
  /** `[security] approvals` — the daemon-wide fallback. */
  daemon: ApprovalLevel;
}): ApprovalResolution {
  if (input.agent && input.agent !== "per-person") {
    return { level: input.agent, source: "agent" };
  }
  if (input.person) return { level: input.person, source: "person" };
  return { level: input.daemon, source: "daemon" };
}

/** Asked at every level, `trusted` too. */
const NEVER_SKIPPED: ReadonlySet<HardlineClass | undefined> = new Set<HardlineClass>(["unwatched", "shared-tools", "persona", "people"]);

/**
 * Whether a call the gate wants to ask about may run anyway.
 *
 * `hardlineClass` is the entry of the fixed list it is on, or `undefined` for a question that is on none — a new
 * command, a mutating tool. `careful` answers nothing by itself; `balanced` everything but `BALANCED_ASKS`; `trusted`
 * everything, which is the whole point of `trusted` and the reason it is kept away from every unauthenticated surface.
 */
export function skipsApproval(level: ApprovalLevel, hardlineClass: HardlineClass | undefined): boolean {
  // Work nobody watches, sending somewhere it was not told to (0.8.0): `trusted` is a person choosing not to be asked
  // about what they are there to see, and nobody is there to see this.
  // A program every agent runs, installed as the daemon's user (0.8.1): asked under `trusted` too, for the same reason.
  // An agent's own persona (0.8.8): it holds the rules that ask, and a level is not the owner reading the change.
  // Who People says a person is (0.8.9): an admin is a person there, and a chat id linked to one answers as an admin.
  if (NEVER_SKIPPED.has(hardlineClass)) return false;
  if (level === "trusted") return true;
  if (level === "balanced") return autoApprovable(hardlineClass);
  /**
   * `careful`, and anything that is not one of the three.
   *
   * The order used to be the other way round — two exact comparisons and then `balanced` (then `risky`) as the
   * fall-through — and the type made that look exhaustive. It is not: this level arrives from a TOML file, and
   * `approvals = "nromal"` once started the daemon and landed here as `balanced`. A typo made while tightening
   * loosened instead. The enum in `CONFIG_ENUMS` refuses that value now; this makes the unreachable case land on the
   * safe side rather than the permissive one.
   */
  return false;
}

/** One line for a person: what is set, and who set it. */
export function describeApprovalLevel(resolution: ApprovalResolution): string {
  const what: Record<ApprovalLevel, string> = {
    careful: "a new command or change asks once, and deletes, teardowns, force-pushes and the rest of the fixed list every time",
    balanced: "only a config.toml changed, someone given access, the daemon stopped, a secret replaced, a credential leaving and this machine's packages changed ask, besides the few every level asks",
    trusted: "nothing asks, but work nobody watches still asks before it sends somewhere its job did not name, and a program installed for every agent, a change to an agent's own persona and a change to who People says a person is ask too",
  };
  const who: Record<ApprovalResolution["source"], string> = {
    agent: "set on this agent, so it applies to everyone talking to it",
    person: "set by you, and it follows you across agents that do not decide for themselves",
    daemon: "the daemon default, because neither this agent nor you have set one",
  };
  return `\`${resolution.level}\`, where ${what[resolution.level]} (${who[resolution.source]}).`;
}
