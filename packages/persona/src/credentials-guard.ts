/**
 * Refuse to start when the credentials directory is somewhere the model can read.
 *
 * `[security] credentials_dir` is configurable, which is right — an operator may reasonably want it
 * beside a project's skills, or on another disk. But every placement is not equally safe, and the
 * unsafe ones fail *silently*: point it inside an agent's pack or a declared workspace root and
 * `read` will happily return a service-account key, because the whole design rests on that
 * directory being outside every root rather than on any check at read time.
 *
 * There is no symptom to notice. The daemon boots, the scripts work, and the only difference is
 * that one `read` call now returns a private key into a conversation — and from there into the
 * provider's request log, the session on disk, and whatever the model says next.
 *
 * So this is a refusal rather than a warning (invariant 7). A warning about a security property is
 * a warning nobody reads twice, and the cost of being wrong is unbounded while the cost of being
 * refused is one line of config.
 */

import { escapes, relative, resolve } from "@nouride/runtime";
import { ConfigError, type LoadedAgent } from "@nouride/shared";

/**
 * Is `child` inside `parent`, or the same directory?
 *
 * `isAbsolute(rel)` and not `resolve(rel).startsWith("/")`: `resolve` makes *everything* absolute by
 * joining against the working directory, so that test is always false and the guard degrades to
 * exact-match only. Written the wrong way first, and every "inside a root" case passed — a guard
 * that appears to work is worse than none, because nobody looks at it again.
 */
function contains(parent: string, child: string): boolean {
  return !escapes(relative(resolve(parent), resolve(child)));
}

export interface CredentialsGuardInput {
  credentialsDir: string;
  agents: LoadedAgent[];
  /** `agents/skills` — the pool, readable by every agent, so it counts. */
  skillsDir: string;
  /** `data/workspace/shared`, and each agent's private directory. */
  workspaceDirs: string[];
}

/**
 * Every directory an agent's file tools can reach, paired with why.
 *
 * Named rather than just listed, because the refusal has to tell the operator which setting put the
 * credentials within reach — "it is inside a root" is not actionable when there are five of them.
 */
function readableRoots(input: CredentialsGuardInput): { path: string; because: string }[] {
  const roots = input.workspaceDirs.map((path) => ({ path, because: "a workspace directory" }));
  roots.push({ path: input.skillsDir, because: "the skills directory" });

  for (const agent of input.agents) {
    const id = agent.config.id;
    roots.push({ path: agent.dir, because: `the pack of agent "${id}"` });
    for (const root of agent.config.workspaceRoots) {
      roots.push({ path: root, because: `[workspace] roots of agent "${id}"` });
    }
    for (const root of agent.config.skillRoots) {
      roots.push({ path: root, because: `[workspace] skill_roots of agent "${id}"` });
    }
  }
  return roots;
}

export function assertCredentialsUnreadable(input: CredentialsGuardInput): void {
  for (const root of readableRoots(input)) {
    if (!contains(root.path, input.credentialsDir)) continue;

    throw new ConfigError(
      `refusing to start: [security] credentials_dir is inside ${root.because}.\n` +
        `  credentials_dir  ${input.credentialsDir}\n` +
        `  reachable via    ${root.path}\n\n` +
        `Anything in there can be read by the agent with the \`read\` tool, and a credential that ` +
        `reaches a conversation is in the provider's request log, the session on disk, and whatever ` +
        `the model says next.\n` +
        `Move it somewhere no root contains (the default, <data_dir>/credentials, is outside all of ` +
        `them), or drop the root that reaches it.`,
    );
  }
}
