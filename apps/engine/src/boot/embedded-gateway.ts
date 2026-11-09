/**
 * Bringing up the gateway a build carries, and agreeing a first-run password with it.
 *
 * Separate from `index.ts` because the two things here are one decision, not two: the gateway
 * bootstraps its own admin account while it boots, so the only moment at which the daemon can make
 * both halves agree on a password is the moment before that boot. Splitting them across a hundred
 * lines of daemon startup is how they would drift apart.
 */

import type { SqliteDb } from "@nouride/runtime";
import type { GlobalConfig } from "@nouride/shared";
import type { EmbeddedGateway } from "@/modules/gateways/nougate-inproc.ts";
import { seedSharedInitialAdmin } from "@/modules/users/bootstrap.ts";
import { UserStore } from "@/modules/users/users.store.ts";

/**
 * How the gateway came to hold the same admin credential as this daemon — or nothing, if it did not.
 *
 * Two ways, and the wizard has to say which, because the sentence differs. `"environment"` is the
 * operator's own `INITIAL_ADMIN_*`, which both products read under the same names and which is still
 * the password they know. `"generated"` is one this daemon made up and lent, which the operator
 * replaces on their very next click — `mustChangePassword` routes a first login through `/welcome`
 * before anything else — leaving the gateway on the old one.
 */
export type CredentialSharing = "environment" | "generated";

export interface BundledGateway {
  gateway: EmbeddedGateway;
  /**
   * The password the gateway was given, when this is a first run and nobody chose one.
   *
   * Handed back so the dashboard's own account can be created with the same one — and, because it
   * travels as a value rather than as `INITIAL_ADMIN_PASSWORD`, still marked for a forced change.
   */
  initialAdminPassword?: string;
  /** Absent when the gateway came up holding a credential of its own. */
  credentialSharing?: CredentialSharing;
}

/**
 * Whether the gateway runs at this start, and whether the environment decided it.
 *
 * `NOUGATE_IN_PROCESS` over `[nougate] in_process`: set, it decides for the whole life of the process, and the
 * dashboard's switch shows what it decided without being able to move it — a value written to the file would change
 * nothing while the variable is there.
 */
export function gatewayDecision(config: GlobalConfig, env: Record<string, string | undefined> = process.env): { on: boolean; decidedBy: "environment" | null } {
  const override = env.NOUGATE_IN_PROCESS;
  if (override !== undefined) return { on: override === "true" || override === "1", decidedBy: "environment" };
  return { on: config.nougate.inProcess, decidedBy: null };
}

/**
 * Start it — at boot when the config says so, or later when the dashboard turns it on (`gateway-switch.ts`).
 *
 * At boot it starts after `providers` is built rather than beside the other listeners: a provider profile may point
 * at this port, and bringing it up any later would let the first turn race the thing it depends on. `nougate-inproc.ts`
 * has what hosting it here trades.
 *
 * Started from the dashboard, an account already exists, so this is no first run and nothing is lent: the gateway
 * creates its own admin as it always does on a first boot of its own, which nobody needs, because its console is the
 * LLM Gateway page and that is signed in through this daemon.
 */
export async function startBundledGateway(input: {
  config: GlobalConfig;
  db: SqliteDb;
}): Promise<BundledGateway> {
  /**
   * Both facts from one call, which is the point of it answering with a mode.
   *
   * The operator's own `INITIAL_ADMIN_*` needs nothing arranged — both products read those two
   * names — and that path reported nothing until 2026-09-16, because this used to ask "did the
   * daemon lend a password" rather than "is the credential shared". So the commonest setup there
   * is, `INITIAL_ADMIN_*` in a `.env`, drew no line at all in the wizard. Found in a screenshot.
   */
  const shared = seedSharedInitialAdmin({ firstRun: new UserStore({ db: input.db }).count() === 0 });
  const lent = shared?.mode === "generated" ? shared : null;
  try {
    const { startEmbeddedNougate } = await import("@/modules/gateways/nougate-inproc.ts");
    const gateway = await startEmbeddedNougate(input.config.nougate.port, {
      dataDir: input.config.daemon.dataDir,
      // The LLM Gateway page needs the dashboard and its users; without them the gateway keeps its own sign-in.
      hostedDashboard: input.config.dashboard.enabled,
    });
    return {
      gateway,
      ...(lent ? { initialAdminPassword: lent.password } : {}),
      ...(shared ? { credentialSharing: shared.mode } : {}),
    };
  } finally {
    // In `finally` so a gateway that fails to boot does not leave a generated admin password sitting
    // in the environment of every command the agent later runs.
    lent?.clear();
  }
}
