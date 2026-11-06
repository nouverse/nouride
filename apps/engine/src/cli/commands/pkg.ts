/**
 * `nouride pkg` — install, remove and upgrade system packages through `nouride-pkg`.
 *
 * No daemon involved: this talks to the root service (`/run/nouride-pkg.sock`) directly, so it works
 * while the daemon is down and for an operator at a terminal. An agent reaches it through the
 * `nouride` tool, where `install`, `remove` and `upgrade` are the fixed list's `system-packages` — asked
 * every time, never a standing grant, never covered by auto-approval. `status`, `check` and `refresh`
 * change nothing an operator would need to approve and are not gated.
 *
 * What a change may touch is decided by the service, as root, whoever asks: repositories only, by
 * exact name, and nothing that would remove a protected package. See `packages/system-packages/root`.
 *
 * Off unless the box was installed with `--allow-packages`; then this says how to turn it on.
 */

import { BOLD, DIM, GREEN, RED, RESET, YELLOW, emit, fail, say, usageError } from "@/cli/ui.ts";
import { EDITION } from "@/commons/build.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { installDirFor } from "@/modules/update/facts.ts";
import { localPackageSetup, resolveSystemPackages } from "@/modules/system-packages/index.ts";
import { enableAdvice, type PackageSetup } from "@/modules/system-packages/setup.ts";
import type { PackageAnswer, PackageRequest } from "nouride-system-packages";

const USAGE = "nouride pkg [status] | check <install|remove|upgrade> <name …> | install <name …> | remove <name …> | upgrade [name …] | refresh";

type Provider = NonNullable<Awaited<ReturnType<typeof resolveSystemPackages>>>;

/** A request the arguments make, or what is wrong with them — exit 2, with the hint. */
export function requestFrom(
  mod: Pick<Provider, "isPackageOp" | "isPackageName">,
  args: readonly string[],
): PackageRequest | { usage: string; hint: string } {
  const [first = "status", ...rest] = args;
  if (first === "status" || first === "refresh") {
    return rest.length > 0 ? { usage: `${first} takes no package names`, hint: USAGE } : { op: first };
  }
  const check = first === "check";
  const [op, ...names] = check ? rest : [first, ...rest];
  if (!mod.isPackageOp(op)) return { usage: `unknown: nouride pkg ${args.join(" ")}`, hint: USAGE };
  if (op !== "upgrade" && names.length === 0) return { usage: `${op} needs at least one package name`, hint: USAGE };
  const bad = names.find((name) => !mod.isPackageName(name));
  if (bad) return { usage: `not a package name: ${bad}`, hint: "lowercase letters, digits and . + _ - (no versions, paths or options)" };
  return { op, names, check };
}

/**
 * The service's streamed output, as lines to show: whole lines only — a partial one is held until the rest arrives —
 * and never its `@nouride-pkg ` status lines, which are the answer `report` says in its own colour.
 */
export function lineFilter(): (chunk: string) => string[] {
  let pending = "";
  return (chunk) => {
    pending += chunk;
    const cut = pending.lastIndexOf("\n");
    if (cut < 0) return [];
    const lines = pending.slice(0, cut).split("\n").filter((line) => !line.startsWith("@nouride-pkg "));
    pending = pending.slice(cut + 1);
    return lines;
  };
}

/**
 * The install directory, for naming `--dir` in the command that turns this on — and only for that,
 * so a config that does not load does not stop a request that needs none of it. Soft: one this user may not read would
 * otherwise end the command.
 */
async function installDir(): Promise<string> {
  try {
    return installDirFor((await loadConfig({ soft: true })).config.daemon.dataDir);
  } catch {
    return "/srv/nouride";
  }
}

export async function pkg(args: readonly string[]): Promise<void> {
  const mod = await resolveSystemPackages();
  if (!mod) return fail("system packages are not available in this build");
  const request = requestFrom(mod, args);
  if ("usage" in request) return usageError(request.usage, request.hint);
  const unready = unreadyAnswer(localPackageSetup({ edition: EDITION, installDir: await installDir() }));
  if (unready?.state === "not-applicable") return fail(unready.error);
  if (unready) {
    emit(unready);
    say(`${YELLOW}!${RESET} system packages are off on this box.`);
    say(`  ${unready.advice}`);
    process.exitCode = 1;
    return;
  }

  // Streamed: an install prints for minutes, and the last line is ours, so it is held back until the
  // whole answer is in and shown in its own colour.
  const lines = lineFilter();
  const answer = await mod.askPackages(request, {
    onData: (chunk) => {
      for (const line of lines(chunk)) say(`${DIM}${line}${RESET}`);
    },
  });
  report(request, answer);
}

/**
 * What `pkg` answers without asking the service, or null when it is ready to be asked: on a box that does not use
 * system packages, why (`fail`, exit 1); on one where they are off, how to turn them on (exit 1, the advice in `--json`).
 */
export function unreadyAnswer(
  setup: PackageSetup,
): { state: "not-applicable"; error: string } | { state: "off"; error: string; advice: string | null } | null {
  if (setup.state === "not-applicable") return { state: "not-applicable", error: `system packages are not used here: ${setup.why}` };
  if (setup.state === "off") return { state: "off", error: "system packages are off on this box", advice: enableAdvice(setup) };
  return null;
}

/** What `--json` answers with: the service's answer, and for one that is not `ok`, its reason as the envelope's error. */
export function pkgAnswer(answer: PackageAnswer): PackageAnswer & { error?: string } {
  return answer.status === "ok" ? answer : { ...answer, error: `${answer.status}: ${answer.detail}` };
}

/** 0 for an answer that is ok; 2 for a refusal — what was asked may not be done; 1 for anything else. */
export function exitCodeFor(answer: Pick<PackageAnswer, "status">): number {
  return answer.status === "ok" ? 0 : answer.status === "refused" ? 2 : 1;
}

function report(request: PackageRequest, answer: PackageAnswer): void {
  emit(pkgAnswer(answer));
  if (answer.status !== "ok") {
    say(`${RED}✗${RESET} ${answer.status}: ${answer.detail}`);
    process.exitCode = exitCodeFor(answer);
    return;
  }
  if (request.op === "status") return say(`${GREEN}✓${RESET} ready: ${BOLD}${answer.detail}${RESET}`);
  const change = [
    answer.installs.length > 0 ? `${answer.installs.length} to install or upgrade` : "",
    answer.removes.length > 0 ? `${answer.removes.length} to remove` : "",
  ].filter(Boolean);
  say(`${GREEN}✓${RESET} ${answer.detail}${change.length > 0 ? ` (${change.join(", ")})` : ""}`);
}
