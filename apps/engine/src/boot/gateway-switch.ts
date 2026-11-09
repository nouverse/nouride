/**
 * The LLM gateway a build carries, on or off: started at boot when the config says so, or later, once, when the
 * dashboard turns it on.
 *
 * Every official build carries the gateway and has it off until asked, so the first time most people meet it is the
 * setup wizard's "Use Nougate". That cannot wait for a restart: a container started without a restart policy does not
 * come back from one, and the wizard would hang on a daemon that is gone. So the boot hands this out in place of the
 * gateway, and everything that used the gateway it started asks this for the one running now: the setup state and the
 * wizard (`routes/setup.ts`, `SetupService`), the `/llm-gateway` mount, and the shutdown.
 *
 * Once per process. The gateway registers its providers and opens its database as it boots and does not claim to be
 * idempotent, so a second boot in one process would register each provider twice. A start that failed is not tried
 * again until Nouride restarts; turning it off writes the setting and restarts, which is the other end of the same
 * rule.
 */

import type { SqliteDb } from "@nouride/runtime";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import type { AuditPort } from "@/commons/audit.store.ts";
import { GATEWAY_CARRIED } from "@/commons/build.ts";
import { editDaemonConfig } from "@/modules/config/config-file.ts";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import type { EmbeddedGateway } from "@/modules/gateways/nougate-inproc.ts";
import { gatewayDecision, startBundledGateway, type BundledGateway, type CredentialSharing } from "@/boot/embedded-gateway.ts";

const log = createLogger("nougate.switch");

/**
 * The switch, made and turned to where this start has it — the boot's one call. `initialAdminPassword` is the first-run
 * password the gateway was lent at this start, for the dashboard's own first account (`startBundledGateway`).
 */
export async function bootGatewaySwitch(input: {
  config: GlobalConfig;
  configPath: string;
  db: SqliteDb;
  audit: Pick<AuditPort, "record">;
}): Promise<{ gateway: GatewaySwitch; initialAdminPassword?: string }> {
  const decision = gatewayDecision(input.config);
  const gateway = new GatewaySwitch({
    carried: GATEWAY_CARRIED,
    decidedBy: decision.decidedBy,
    start: () => startBundledGateway({ config: input.config, db: input.db }),
    save: gatewaySaver(input),
  });
  return { gateway, ...(await gateway.boot(decision.on)) };
}

/**
 * `[nougate] in_process` written through the one config writer, which keeps the rest of the file as it was and has the
 * running config follow it — and the switch audited, as a change to what reaches every upstream account.
 */
export function gatewaySaver(input: { config: GlobalConfig; configPath: string; audit: Pick<AuditPort, "record"> }): GatewaySwitchDeps["save"] {
  return async (on, actor) => {
    const saved = await editDaemonConfig(input.configPath, input.config, (text) => upsertTomlTable(text, "nougate", { in_process: on }));
    if (!saved.ok) return saved;
    input.audit.record({ action: "llm_gateway_switched", actor, details: { on } });
    return { ok: true };
  };
}

export type TurnedOn =
  /** `saved`: the file says on — false where the environment decides, or the write failed after it started. */
  | { ok: true; started: boolean; saved: boolean; error?: string }
  | { ok: false; why: "not-carried" | "environment" | "failed"; error: string };

export type TurnedOff =
  /** `running`: still serving until the restart that stops it. */
  | { ok: true; running: boolean }
  | { ok: false; why: "not-carried" | "environment" | "not-saved"; error: string };

/** What the control plane and the wizard read of it. */
export interface GatewayPort {
  /** Whether this build carries the gateway, on or off. A gateway running here is carried, whatever the stamp says. */
  readonly carried: boolean;
  /** `environment` when `NOUGATE_IN_PROCESS` decides, and the switch cannot move it; null when the file does. */
  readonly decidedBy: "environment" | null;
  /** The gateway running in this process now, or null. */
  current(): EmbeddedGateway | null;
  /** How it came to hold this daemon's admin credential, when it did — see `CredentialSharing`. */
  credentialSharing(): CredentialSharing | undefined;
  turnOn(actor: string): Promise<TurnedOn>;
  /** Writes it off. The process keeps serving it until a restart: the caller asks for one. */
  turnOff(actor: string): Promise<TurnedOff>;
}

export interface GatewaySwitchDeps {
  carried: boolean;
  decidedBy: "environment" | null;
  /** Starts the gateway, or throws why it did not — `startBundledGateway`. */
  start: () => Promise<BundledGateway>;
  /** `[nougate] in_process` written, through the one config writer. */
  save: (on: boolean, actor: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export class GatewaySwitch implements GatewayPort {
  private running: EmbeddedGateway | null = null;
  private sharing: CredentialSharing | undefined;
  /** The one start this process makes, settled or not. */
  private starting: Promise<BundledGateway> | null = null;
  private failure: string | null = null;

  constructor(private readonly deps: GatewaySwitchDeps) {}

  get carried(): boolean {
    return this.deps.carried || this.running !== null;
  }

  get decidedBy(): "environment" | null {
    return this.deps.decidedBy;
  }

  current(): EmbeddedGateway | null {
    return this.running;
  }

  credentialSharing(): CredentialSharing | undefined {
    return this.sharing;
  }

  /**
   * At boot, where the config or the environment turns it on. A failure here stops the boot, as it always did: a
   * provider pointed at a gateway that is not there fails every turn, and a build that cannot carry it is refused by
   * name (`nougate-inproc.ts`).
   */
  async boot(on: boolean): Promise<{ initialAdminPassword?: string }> {
    if (!on) return {};
    const started = await this.launch();
    return started.initialAdminPassword ? { initialAdminPassword: started.initialAdminPassword } : {};
  }

  async turnOn(actor: string): Promise<TurnedOn> {
    if (this.running) return { ok: true, started: false, saved: this.deps.decidedBy === null };
    if (!this.deps.carried) return { ok: false, why: "not-carried", error: "this build does not carry the LLM gateway" };
    if (this.deps.decidedBy) return { ok: false, why: "environment", error: "NOUGATE_IN_PROCESS is set in the environment, and it decides" };
    if (this.failure) return { ok: false, why: "failed", error: `it did not start earlier, and starts again only after a restart: ${this.failure}` };
    try {
      await this.launch();
    } catch (err) {
      return { ok: false, why: "failed", error: this.failure ?? String(err) };
    }
    // After it answers, never before: written first, a gateway that then failed to start would fail the next boot too.
    const saved = await this.deps.save(true, actor);
    log.info("LLM gateway turned on", { actor, saved: saved.ok });
    if (!saved.ok) {
      log.warn("the LLM gateway is on, but the setting was not saved: it is off again after a restart", { error: saved.error });
      return { ok: true, started: true, saved: false, error: saved.error };
    }
    return { ok: true, started: true, saved: true };
  }

  async turnOff(actor: string): Promise<TurnedOff> {
    if (!this.carried) return { ok: false, why: "not-carried", error: "this build does not carry the LLM gateway" };
    if (this.deps.decidedBy) return { ok: false, why: "environment", error: "NOUGATE_IN_PROCESS is set in the environment, and it decides" };
    const saved = await this.deps.save(false, actor);
    if (!saved.ok) return { ok: false, why: "not-saved", error: saved.error };
    log.info("LLM gateway turned off", { actor, running_until_restart: this.running !== null });
    return { ok: true, running: this.running !== null };
  }

  /** At shutdown: the gateway that runs, or the one still starting, stopped. */
  async stop(): Promise<void> {
    const gateway = this.running ?? (await this.starting?.then((started) => started.gateway).catch(() => null)) ?? null;
    await gateway?.stop();
  }

  /** The one start: a second caller waits on the first's. */
  private launch(): Promise<BundledGateway> {
    this.starting ??= this.deps.start().then(
      (started) => {
        this.running = started.gateway;
        this.sharing = started.credentialSharing;
        return started;
      },
      (err: unknown) => {
        this.failure = err instanceof Error ? err.message : String(err);
        log.warn("the LLM gateway did not start", { error: this.failure });
        throw err;
      },
    );
    return this.starting;
  }
}
