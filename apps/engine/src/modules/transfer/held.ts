/**
 * An install that was imported and has not gone live.
 *
 * An import brings another machine's connections and automations with it. Started as they are, a bot's token would be
 * asking its platform for the same messages from two machines at once, and an automation that runs a command would run
 * it here the moment the daemon came up. So an imported install starts held: its connections to chat apps are not
 * started and its scheduler does not run, until a person says "Go live", once the old machine is off. The dashboard
 * and its own chat are on throughout: they are how the person gets here.
 *
 * The mark is a row of the database the import brought (`imported`), written before the daemon first opens it, with
 * what the import brought and left: the page that says how it went reads the same row.
 */

import type { GatewayInstanceConfig } from "@nouride/shared";
import type { ImportReport } from "@nouride/wire";
import type { StateRows } from "@/commons/daemon-state.store.ts";

/** The import this install came from: null for one that was never imported, or whose note was put away. */
export function importedOf(rows: Pick<StateRows, "get">): ImportReport | null {
  try {
    const text = rows.get("imported");
    const value = text ? (JSON.parse(text) as ImportReport | null) : null;
    return value && typeof value === "object" && typeof value.at === "number" ? value : null;
  } catch {
    return null;
  }
}

/** Whether connections and automations are held back: imported, and not gone live. */
export function heldBack(rows: Pick<StateRows, "get">): boolean {
  const imported = importedOf(rows);
  return imported !== null && !imported.live;
}

export function recordImport(rows: Pick<StateRows, "set">, report: ImportReport): void {
  rows.set("imported", JSON.stringify(report));
}

/** "Go live": the mark turned, for this run and every start after it. The report as it now stands, or null with none. */
export function markLive(rows: StateRows): ImportReport | null {
  const imported = importedOf(rows);
  if (!imported) return null;
  const live = { ...imported, live: true };
  recordImport(rows, live);
  return live;
}

/**
 * The connections the daemon makes as it starts: while held, none of them. Not one made and left unstarted: an adapter
 * that exists can be asked to send, and a bot's token would then be used from two machines.
 */
export function connectionsFor(configured: readonly GatewayInstanceConfig[], held: boolean): GatewayInstanceConfig[] {
  return configured.map((gateway) => (held ? { ...gateway, enabled: false } : gateway));
}
