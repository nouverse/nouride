/**
 * What runs a catalog entry's package on this machine, whether it can, and what to say when it cannot (0.7.19).
 *
 * A stdio server is a package started through a program: npm's through `npx`, Python's through `uvx`, an image through
 * `docker`. Whether that program is here is a fact about the box the daemon runs on — not about core, which serves the
 * catalog to every box, nor about the browser, which may be on another machine — so it is looked up here, on the PATH
 * the server itself would be started with.
 *
 * Being on the PATH is not always enough. Docker's CLI is often installed where its daemon is not running, or where the
 * service user cannot reach its socket: that is said as such, because "install Docker" would send the person to fix
 * the wrong thing.
 */

import { canReadWrite, statFile, whichBinary } from "@nouride/runtime";
import type { InstallDraft } from "./draft.ts";

export type RunnerId = "npx" | "uvx" | "docker";

export interface Runner {
  id: RunnerId;
  /** The program a server is started with. */
  command: string;
  /** What a person installs, by its own name. */
  needs: string;
  via: InstallDraft["runsVia"];
  /**
   * How to get it, said for an admin: on a native Debian-like box, through `nouride pkg`; in the container image what
   * works there — `nouride pkg` too since 0.8.15, which the image serves and a recreate keeps, or no root at all.
   */
  install: Record<Machine, string>;
}

/** Where the daemon runs, as far as getting a program goes. */
export type Machine = "native" | "container";

/** The container image's entrypoint says so (`scripts/docker-entrypoint.sh`); anything else installs natively. */
export function machineKind(env: Record<string, string | undefined> = process.env): Machine {
  return (env.NOURIDE_CONTAINER_SUPERVISOR ?? "").trim() === "entrypoint" ? "container" : "native";
}

/**
 * By the kind of package each starts, easiest to install first: when an entry comes in more than one, the first a box
 * lacks is the one to suggest.
 */
const RUNNERS: Record<string, Runner> = {
  npm: {
    id: "npx",
    command: "npx",
    needs: "Node.js",
    via: "npm",
    install: {
      native: "`nouride pkg install nodejs npm`",
      // Node's own builds are for glibc and the image is Alpine (musl): a system package — through the image's
      // nouride-pkg, kept across a recreate (0.8.15), or baked in at build time.
      container: '`nouride pkg install nodejs npm`, kept across a recreate, or build the image with `--build-arg EXTRA_PACKAGES="nodejs npm"`',
    },
  },
  pypi: {
    id: "uvx",
    command: "uvx",
    needs: "uv",
    via: "pypi",
    install: {
      // Debian has no uv package; pipx installs it into the install's own bin, where the daemon finds it.
      native: "`nouride pkg install pipx`, then `pipx install uv` as the service user",
      // uv is one binary with a musl build: put in .nouride/bin it is in the volume, and outlives the container. An
      // agent can do this itself — no root, no system package. `wget`, because the image has busybox's and no curl.
      container:
        "put its standalone binary in .nouride/bin, where it stays in the volume: `wget -qO- https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=$NOURIDE_BIN UV_NO_MODIFY_PATH=1 sh` (an agent can run this itself)",
    },
  },
  oci: {
    id: "docker",
    command: "docker",
    needs: "Docker",
    via: "docker",
    install: {
      native: "`nouride pkg install docker.io`, and give the service user its socket (the docker group, which is root in effect)",
      // Docker in Docker is the host's socket handed in: root over the host, which is not a default to suggest.
      container: "not from inside a container. Use the server's npm or Python form if it has one",
    },
  },
};

const EASE = ["npm", "pypi", "oci"];

/** Whether a program can run here: true, false (not on the PATH), or why it is there and still cannot. */
export type CanRun = (command: string) => boolean | { unusable: string };

/**
 * Why an entry cannot run here, in a shape a badge can be built from: the programs it needs — any one of them would do,
 * easiest first — with why any of those that are installed cannot be used; or, when it comes in no form Nouride starts,
 * the forms it does come in.
 */
export interface Blocker {
  needs: RunnerId[];
  unusable?: Partial<Record<RunnerId, string>>;
  forms?: string[];
}

const byId = (id: RunnerId) => Object.values(RUNNERS).find((runner) => runner.id === id)!;

/** The runners of these package kinds, easiest first. */
export function runnersOf(kinds: readonly string[]): Runner[] {
  return [...new Set(kinds)]
    .filter((kind) => RUNNERS[kind] !== undefined)
    .sort((a, b) => EASE.indexOf(a) - EASE.indexOf(b))
    .map((kind) => RUNNERS[kind]!);
}

/** The first of these that can run here, or why none can (pure: `can` answers for the machine). */
export function pickRunner(runners: readonly Runner[], can: CanRun): { runner: Runner } | { blocked: Blocker } {
  const unusable: Partial<Record<RunnerId, string>> = {};
  for (const runner of runners) {
    const answer = can(runner.command);
    if (answer === true) return { runner };
    if (answer !== false) unusable[runner.id] = answer.unusable;
  }
  return { blocked: { needs: runners.map((runner) => runner.id), ...(Object.keys(unusable).length ? { unusable } : {}) } };
}

/** The sentence for a blocker: what is missing, and how to get it on this kind of machine. */
export function blockerText(blocked: Blocker, machine: Machine = machineKind()): string {
  if (blocked.needs.length === 0) return `Nouride cannot run it yet: it comes as ${blocked.forms?.join(", ") || "nothing it can start"}.`;
  const runners = blocked.needs.map(byId);
  const missing = runners.filter((runner) => !blocked.unusable?.[runner.id]);
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`It needs ${missing.map((runner) => runner.needs).join(" or ")}, which this machine does not have.`);
    for (const runner of missing) parts.push(`${runner.needs}: ${runner.install[machine]}.`);
  }
  for (const runner of runners) {
    const why = blocked.unusable?.[runner.id];
    if (why) parts.push(`${runner.needs} is installed but cannot be used: ${why}.`);
  }
  return parts.join(" ");
}

/** The badge for a blocker: "needs uv", "needs uv or Docker", "Docker not usable", "not supported". */
export function blockerLabel(blocked: Blocker): string {
  if (blocked.needs.length === 0) return "not supported";
  if (blocked.needs.every((id) => blocked.unusable?.[id])) return `${blocked.needs.map((id) => byId(id).needs).join(" or ")} not usable`;
  return `needs ${blocked.needs.map((id) => byId(id).needs).join(" or ")}`;
}

/** How long what this machine has is trusted: an admin who installs uv sees its servers become addable within it. */
const CHECKED_FOR_MS = 30_000;

/**
 * This machine's answer, read from the daemon's PATH and, for Docker, its socket. Kept for half a minute: a search is
 * twenty cards asking the same three questions.
 */
export function machineCan(
  deps: {
    which?: (command: string) => string | null;
    canReadWrite?: (path: string) => boolean;
    exists?: (path: string) => boolean;
    env?: Record<string, string | undefined>;
    now?: () => number;
  } = {},
): CanRun {
  const which = deps.which ?? whichBinary;
  const reachable = deps.canReadWrite ?? canReadWrite;
  const exists = deps.exists ?? ((path: string) => statFile(path) !== null);
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const known = new Map<string, { answer: boolean | { unusable: string }; at: number }>();
  const look = (command: string): boolean | { unusable: string } => {
    if (which(command) === null) return false;
    if (command !== "docker" || env.DOCKER_HOST) return true;
    const socket = ["/var/run/docker.sock", "/run/docker.sock"].find(exists);
    if (!socket) return { unusable: "its daemon is not running here (no /var/run/docker.sock)" };
    return reachable(socket) ? true : { unusable: `the service user cannot reach ${socket}` };
  };
  return (command) => {
    const held = known.get(command);
    if (held && now() - held.at < CHECKED_FOR_MS) return held.answer;
    const answer = look(command);
    known.set(command, { answer, at: now() });
    return answer;
  };
}
