/**
 * What `doctor` says about each agent's commands running as its own user (0.8.0): whether they do and why, the
 * kernel's Landlock, each agent's user and whether it reads the credentials directory, and a declared root an agent's
 * user cannot reach — with the one command, the operator's to run, that grants it (the isolation RFC's §8).
 */

import type { AgentUsersFinding, LandlockMode } from "@nouride/isolation";
import { canHaveOwnUser } from "@/boot/agent-users.ts";
import type { Check } from "@/cli/commands/doctor-checks.ts";

/**
 * Where agents' commands run, and Landlock: answered with the daemon down. `running` is how the daemon that is up runs
 * them (`/health`'s `agentUsers`): one running them through a socket that is not there now is one whose every agent's
 * command fails — not a host without the helper.
 */
export function agentUsersChecks(finding: AgentUsersFinding, o: { expected: boolean; landlock: LandlockMode; running?: "socket" | "local" | null }): Check[] {
  if (!finding.users && o.running === "socket") {
    return [
      {
        level: "bad",
        message: `agents' commands: the daemon runs them through nouride-run.socket, and it is not answering: every agent's command fails (${finding.reason.split(";")[0]})`,
        hint: "sudo systemctl start nouride-run.socket (and `journalctl -u nouride-run.socket` says why it stopped).",
      },
    ];
  }
  if (!finding.users) {
    // Expected on a Linux host outside a container: the helper is how agents are kept apart there.
    return [
      o.expected
        ? { level: "warn", message: `agents' commands: as the daemon's own user (${finding.reason})`, hint: "Each agent reaches every other's folder and the daemon's files. install.sh installs the helper and its socket." }
        : { level: "ok", message: `agents' commands: as the daemon's own user (${finding.reason})` },
    ];
  }
  const through = finding.users.through === "socket" ? "nouride-run.socket" : "the helper's rules in-process (the daemon is root)";
  const out: Check[] = [{ level: "ok", message: `agents' commands: each as its own user (nr-<agent>), through ${through}${finding.version ? `, helper ${finding.version}` : ""}` }];
  const kernel = finding.landlock ?? "";
  const lacking = kernel.replace(/^none — /, ""); // em-dash-ok: the nouride-run helper writes this prefix before why a kernel has no Landlock (serve.rs), and installed helpers keep writing it
  if (o.landlock === "off") out.push({ level: "ok", message: "landlock: off ([security.exec] landlock)" });
  else if (kernel.startsWith("none") && o.landlock === "require") {
    out.push({ level: "bad", message: `landlock: required, and this kernel's is ${lacking}, so no agent's command runs`, hint: 'Turn it on in the kernel, or set [security.exec] landlock = "auto".' });
  } else if (kernel.startsWith("none")) out.push({ level: "ok", message: `landlock: ${o.landlock}, and this kernel's is ${lacking}; each agent's own user is the wall` });
  else if (kernel) out.push({ level: "ok", message: `landlock: ${o.landlock}, this kernel's ${kernel}` });
  return out;
}

/** Who is in which group and which users there are, as `/etc/passwd` and `/etc/group` say. */
export interface Accounts {
  users: ReadonlySet<string>;
  members: ReadonlyMap<string, ReadonlySet<string>>;
}

export function readAccounts(passwd: string, group: string): Accounts {
  const users = new Set(passwd.split("\n").map((line) => line.split(":")[0]!).filter(Boolean));
  const members = new Map<string, Set<string>>();
  for (const line of group.split("\n")) {
    const [name, , , list] = line.split(":");
    if (name) members.set(name, new Set((list ?? "").split(",").filter(Boolean)));
  }
  return { users, members };
}

/** Each agent's own user, and whether it reads the credentials directory. */
export function agentUserChecks(agents: readonly { id: string }[], accounts: Accounts): Check[] {
  return agents.map((agent): Check => {
    const user = `nr-${agent.id}`;
    if (!canHaveOwnUser(agent.id)) {
      return { level: "bad", message: `${agent.id}: cannot have a user of its own, so its commands are refused`, hint: `Rename agents/${agent.id}: lowercase letters, digits and dashes, at most 29.` };
    }
    if (!accounts.users.has(user)) return { level: "warn", message: `${agent.id}: no user ${user} yet`, hint: "It is made when the daemon starts, and at the agent's first command." };
    const creds = accounts.members.get("nr-creds")?.has(user) === true;
    return { level: "ok", message: `${agent.id}: runs as ${user}, ${creds ? "reads" : "does not read"} the credentials directory` };
  });
}

/**
 * Whether a command really runs as the agent, tried — in the folder its commands start in, with its Landlock and roots.
 * The accounts say the user is there, not that it works: a helper short of a capability failed every command with
 * exit 126 while every line above read green.
 */
export function commandProbeCheck(agent: string, out: { exitCode: number | null; stdout: string; stderr: string } | null): Check | null {
  if (out?.exitCode === 0 && out.stdout.trim() === `nr-${agent}`) return null;
  const why = out ? out.stderr.trim().split("\n").at(-1) || `exit ${out.exitCode}` : "the helper did not answer";
  return { level: "bad", message: `${agent}: a command does not run as nr-${agent}: ${why}`, hint: "Every command of its fails the same way. `journalctl -t nouride-run` has the helper's side." };
}

/** A declared root its agent's user cannot read, write and enter — and the grant, the operator's to run. */
export function rootReachCheck(agent: string, root: string, reachable: boolean): Check | null {
  if (reachable) return null;
  const user = `nr-${agent}`;
  return {
    level: "warn",
    message: `${agent}: ${user} cannot write its declared root ${root}, so its commands and its file tools are refused there`,
    hint: `Grant it: sudo setfacl -R -m u:${user}:rwX -m d:u:${user}:rwX ${root}. Where the filesystem has no ACLs: sudo chgrp -R ${user} ${root} && sudo chmod -R g+rwX ${root}`,
  };
}
