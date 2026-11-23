/**
 * Export and import, for the page in Settings (`modules/transfer/service.ts`). An admin's, every one: an export holds
 * every chat and memory, and an import replaces the install.
 *
 * A file for import arrives in pieces, each a request's whole body, written where the last one ended. The import itself
 * asks for the word that confirms it in its body, as an agent's delete asks for its id: the page's dialog has it typed,
 * and a request without it is one somebody did not mean.
 */

import type { ExportPlan, ImportChecked, ImportReport, TransferState } from "@nouride/wire";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { VERSION } from "@/commons/version.ts";
import { CONFIRM_WORD, PASSPHRASE_MIN, Transfer } from "@/modules/transfer/service.ts";
import { atLeast } from "@/modules/users/auth.ts";
import { asciiName, fileResponse } from "../file-response.ts";
import { leftOut } from "../system-files.ts";
import { jsonBody } from "../payloads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

/** The largest piece of an upload taken in one request. */
const PIECE_MAX = 32 * 1024 * 1024;

const ADMIN_ONLY = { error: "admin only", plain: "Only an admin can do this." } as const;

/** The service over what the control routes already hold: nothing is added to the daemon's boot for it. */
function transferOf(deps: ControlDeps): Transfer {
  return new Transfer({
    config: () => deps.ctx.config,
    configPath: deps.ctx.configSource ?? "",
    db: deps.ctx.db,
    state: new DaemonStateStore(deps.ctx.db),
    version: VERSION,
    agents: () => deps.registry.all().map((agent) => agent.config.id),
    secrets: deps.secrets,
    credential: leftOut,
    ...(deps.requestRestart ? { restart: { can: () => deps.supervisor?.().restartsOnExit ?? false, now: deps.requestRestart } } : {}),
    ...(deps.cron ? { scheduler: deps.cron.scheduler } : {}),
  });
}

export function registerTransferRoutes(control: ControlApp, deps: ControlDeps, given?: Transfer): void {
  // Made at the first request: a daemon that never opens the page builds nothing for it.
  let made = given;
  const service = (): Transfer => (made ??= transferOf(deps));
  const admin = (c: { get(key: "principal"): Parameters<typeof atLeast>[0] }) => atLeast(c.get("principal"), "admin");

  control.get("/transfer", (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    return c.json(service().state() satisfies TransferState);
  });

  control.get("/transfer/plan", async (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    return c.json((await service().plan(c.req.query("folders") === "1")) satisfies ExportPlan);
  });

  control.post("/transfer/export", async (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    // No passphrase is a file with no secrets, and has to be said: a missing field is not a decision.
    if (typeof body.passphrase !== "string" && body.secrets !== false) {
      return c.json({ error: "give a passphrase, or secrets: false for a file that holds none", plain: "Type a password for the secrets, or untick them." }, 400);
    }
    const started = service().startExport({ passphrase: body.secrets === false ? null : (body.passphrase as string), folders: body.folders === true });
    if (!started.ok) {
      return c.json({ error: started.error, plain: started.why === "busy" ? "A file is being made already. Wait for it to finish." : `The password needs at least ${PASSPHRASE_MIN} characters.` }, 400);
    }
    deps.audit.record({ action: "install_exported", actor: c.get("principal").actor, details: { secrets: body.secrets !== false, folders: body.folders === true } });
    return c.json(service().state() satisfies TransferState, 202);
  });

  control.get("/transfer/export/download", (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    const file = service().exportFile();
    if (!file) return c.json({ error: "no export is ready", plain: "There is no file to download yet. Make one first." }, 404);
    return fileResponse(file.path, file.bytes, c.req.header("range"), { "content-type": "application/gzip", "content-disposition": `attachment; filename="${asciiName(file.name)}"`, "cache-control": "no-store" });
  });

  control.delete("/transfer/export", (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    service().dropExport();
    return c.json(service().state() satisfies TransferState);
  });

  control.post("/transfer/import/upload", async (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    const at = Number(c.req.query("at") ?? "0");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!Number.isInteger(at) || at < 0 || bytes.length === 0 || bytes.length > PIECE_MAX) {
      return c.json({ error: "a piece is 1 byte to 32 MB, at a whole offset", plain: "The file could not be sent. Try again." }, 400);
    }
    const wrote = await service().upload(at, bytes);
    if (!wrote.ok) return c.json({ error: wrote.error, plain: "The file did not arrive whole. Send it again from the start.", bytes: wrote.bytes }, 409);
    return c.json({ bytes: wrote.bytes } satisfies { bytes: number });
  });

  control.post("/transfer/import/check", async (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const checked = await service().check(typeof body.passphrase === "string" && body.passphrase ? body.passphrase : undefined);
    if ("ok" in checked) {
      const plain =
        checked.why === "newer"
          ? `Update Nouride first. This file was made by Nouride ${checked.from ?? "a newer version"}, which is newer than the one running here (${VERSION}).`
          : checked.why === "passphrase"
            ? "That password does not open this file's secrets. It is the one typed when the file was made."
            : checked.why === "older"
              ? "This file was made by a Nouride too old to bring in here. Update the old machine first, then make the file again."
              : checked.why === "damaged"
                ? "The database in this file is damaged. Make the file again on the old machine."
                : checked.why === "cut-short"
                  ? "This file could not be read to its end. It may have been cut short on its way here."
                  : "This file is not one Nouride made.";
      // A file that only wants its password is told apart by its status: the page then asks for one, and says no error.
      return c.json({ error: checked.error, plain, why: checked.why }, checked.why === "passphrase" ? 422 : 400);
    }
    return c.json(checked satisfies ImportChecked);
  });

  control.post("/transfer/import/apply", async (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (body.confirm !== CONFIRM_WORD) {
      return c.json({ error: `confirm must be the word "${CONFIRM_WORD}"`, plain: `Type ${CONFIRM_WORD} to confirm, exactly as it is shown.` }, 400);
    }
    const actor = c.get("principal").actor;
    // Written before the restart it asks for: the daemon that reads this log next holds another install's.
    deps.audit.record({ action: "install_import_asked", actor, details: {} });
    const done = service().apply(actor);
    if (!done.ok) return c.json({ error: done.error, plain: "Open the file first, so you see what it holds." }, 409);
    return c.json({ restarting: done.restarting } satisfies { restarting: boolean });
  });

  control.delete("/transfer/import", (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    service().cancel();
    return c.json(service().state() satisfies TransferState);
  });

  control.post("/transfer/live", (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    const actor = c.get("principal").actor;
    const live = service().goLive(actor);
    if (!live) return c.json({ error: "this install was not imported", plain: "There is nothing waiting to go live." }, 409);
    deps.audit.record({ action: "install_went_live", actor, details: { connections: live.report.held.connections.length, automations: live.report.held.automations } });
    return c.json(live satisfies { report: ImportReport; restarting: boolean; restart: boolean });
  });

  control.delete("/transfer/imported", (c) => {
    if (!admin(c)) return c.json(ADMIN_ONLY, 403);
    if (!service().putAway()) return c.json({ error: "the import is not live yet", plain: "Go live first: the note stays until then." }, 409);
    return c.json(service().state() satisfies TransferState);
  });
}
