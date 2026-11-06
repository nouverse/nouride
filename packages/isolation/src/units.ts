/**
 * The helper's two systemd units, written by `nouride service install` beside the daemon's own and copied into place
 * by install.sh. Made from the same config the daemon boots from, so the folders the helper serves are the ones boot
 * asks it about (`findAgentUsers`) — one source, not a template and a config to keep in step.
 */

import { HELPER_BINARY, HELPER_SOCKET, type HelperFolders } from "./helper.ts";

/** What the helper's unit may hold, and nothing more — the escape tests run it with exactly these. */
const HELPER_CAPABILITIES = [
  "CAP_SETUID",
  "CAP_SETGID",
  "CAP_CHOWN",
  "CAP_FOWNER",
  "CAP_FSETID",
  "CAP_DAC_OVERRIDE",
  "CAP_DAC_READ_SEARCH",
  "CAP_KILL",
  "CAP_SYS_PTRACE",
  "CAP_SYS_ADMIN",
  "CAP_SYS_CHROOT",
] as const;

/** `user` is the daemon's; `group` its group, the only one beside root that may connect. By file name. */
export function helperUnits(o: { user: string; group: string; folders: HelperFolders }): Record<string, string> {
  const { workspace, reads, credentials } = o.folders;
  const serve = [HELPER_BINARY, "serve", "--workspace", workspace, ...reads.flatMap((dir) => ["--reads", dir]), "--credentials", credentials, "--service-user", o.user];
  const socket = `# Where the Nouride daemon asks for an agent's command to run as that agent's own user. See
# ${HELPER_BINARY} and packages/isolation/README.md.
#
# Written by \`nouride service install\`, installed by install.sh. Only root and the service group may connect: the
# daemon. No agent is ever in that group, so an agent's own command cannot ask for another agent's user. Each
# connection starts one nouride-run@ process as root, and the rules compiled into that binary decide what it may do.

[Unit]
Description=Nouride agents' commands (socket)

[Socket]
ListenStream=${HELPER_SOCKET}
SocketUser=root
SocketGroup=${o.group}
SocketMode=0660
Accept=yes
# Gone when stopped: the daemon reads "is the helper here" from this file, and one left behind would say ready while
# every command was refused.
RemoveOnStop=yes
# A box never runs more at once; more wait in the backlog.
MaxConnections=64

[Install]
WantedBy=sockets.target
`;
  const service = `# One agent's command, started by nouride-run.socket. Root, and without the daemon's sandbox: changing user needs it.
# What it may do is fixed in the binary: a user only of its own making, every path touched after the drop.
#
# Its log: journalctl -t nouride-run

[Unit]
Description=Nouride agent command

[Service]
Type=simple
ExecStart=${serve.join(" ")}
StandardInput=socket
StandardOutput=socket
StandardError=journal
SyslogIdentifier=nouride-run
# Everything but /etc (users and groups) and the folders it gives their owners and groups stays read-only to it. The
# command it starts is the agent's, and its own user's rights are what decide what that may write.
ProtectSystem=strict
# A folder not made yet is skipped (\`-\`), not a unit that fails to start.
ReadWritePaths=/etc ${[workspace, ...reads, credentials].map((dir) => `-${dir}`).join(" ")}
ProtectHome=read-only
# SYS_PTRACE, SYS_ADMIN and SYS_CHROOT to enter the daemon's mount namespace, which is what the command sees: its
# private /tmp and what its unit makes read-only, no more and no less than the daemon's commands always saw. FSETID to
# set a folder setgid for a group root is not in: without it the kernel drops the bit, and what is made in shared/
# stops taking nr-agents. The escape tests run the helper with exactly these (HELPER_CAPS in tests/escape.rs).
CapabilityBoundingSet=${HELPER_CAPABILITIES.join(" ")}
# What the daemon's unit holds its own children to, held here too, since the command is this unit's child now and not
# the daemon's: no namespace but the one it enters (mnt), the same socket families, no personality, no realtime. Not
# RestrictSUIDSGID: setgid folders are how what the daemon writes takes an agent's group. A setgid file gains nothing
# where it runs: every command, and the daemon, has no_new_privs.
RestrictNamespaces=mnt
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
LockPersonality=true
RestrictRealtime=true
`;
  return { "nouride-run.socket": socket, "nouride-run@.service": service };
}
