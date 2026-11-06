/**
 * Which format the vault is in, said by the vault itself: `<vault>/.nouride-vault.json`, holding `{"format": 2}`.
 *
 * The vault is the truth (`index-sync.ts`), and it travels on its own — restored by plain copy (`backup.ts`), synced
 * by tools that know nothing of Nouride, read by whichever build is installed. Until 0.7.8 nothing in it said which
 * shape it was in, and the one change so far was found by looking for flat files in `days/`.
 *
 * - **1** — 0.6: every day hub flat in `days/`.
 * - **2** — 0.7: day hubs by month, `days/YYYY/MM/` (`vault.ts`).
 *
 * Read before anything else touches the vault — before the database is migrated, too. This build reads format 2 and
 * nothing else. Every 0.7.x laid a format-1 vault out by month on its first start, and the last one is on every
 * install's way to 0.8.0, the floor, so a vault still in 1 is refused with the way across rather than moved here. A vault a newer
 * build wrote is refused as well: this build would read its files wrong and write its own shape in among them
 * (invariant 7). A vault from before the marker is format 1 while a hub still sits flat in `days/`, and 2 otherwise —
 * the one place its files are looked at to say.
 *
 * One marker for the vault rather than a field in every file: these are notes people edit in Obsidian, read leniently
 * on purpose (`frontmatter.ts`), and a version on each one is one more line a hand edit can break.
 */

import { listDir, readTextFileIfExists } from "@nouride/runtime";
import { crossTheFloor, EARLIER_FLOOR } from "@/commons/upgrade-floor.ts";
import type { Vault } from "./vault.ts";
import { writeSide } from "./write.ts";

/** The format this build reads and writes. A change to how a vault file is written or read is a new one. */
export const VAULT_FORMAT = 2;

/** A day hub as 0.6 named it, flat in `days/`. */
const FLAT_DAY = /^\d{4}-\d{2}-\d{2}\.md$/;

/** What a vault says about itself — or, when it says nothing, what its files do. */
export interface FoundFormat {
  format: number;
  /** Whether the marker said so; false for a vault from before the marker, read from its files. */
  marked: boolean;
  /** Why a marker that is there could not be read — its files decided instead. */
  unreadable?: string;
}

/** The marker's format, or why the text is not one. */
function markerFormat(text: string): number | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "it is not JSON";
  }
  const format = typeof value === "object" && value !== null ? (value as { format?: unknown }).format : undefined;
  return typeof format === "number" && Number.isInteger(format) && format >= 1 ? format : 'it has no whole number as "format"';
}

/** Which format the vault is in: what its marker says, or for a vault from before the marker, where its day hubs are. */
export async function readVaultFormat(vault: Vault): Promise<FoundFormat> {
  const text = await readTextFileIfExists(vault.formatFile);
  const marker = text === null ? null : markerFormat(text);
  if (typeof marker === "number") return { format: marker, marked: true };
  // The builds that wrote no marker wrote 1 or 2, and only 1 left a hub flat in `days/`.
  const flat = listDir(vault.daysDir).some((entry) => !entry.isDirectory && FLAT_DAY.test(entry.name));
  return { format: flat ? 1 : 2, marked: false, ...(marker === null ? {} : { unreadable: marker }) };
}

/** A vault in a format this build does not read — refused rather than read wrong and written over. */
export class VaultFormatError extends Error {
  override name = "VaultFormatError";
}

/**
 * The vault's format, read before anything else touches it, and refused when it is not this build's. `snapshots` is
 * the directory that holds copies of the vault, which the refusal of a newer one names as the way back.
 */
export async function checkVaultFormat(vault: Vault, snapshots: string): Promise<FoundFormat> {
  const found = await readVaultFormat(vault);
  if (found.format === VAULT_FORMAT) return found;
  if (found.format < VAULT_FORMAT) {
    throw new VaultFormatError(
      `refusing to start: the memory vault at ${vault.root} is format ${found.format}, 0.6's (its day hubs flat in days/), and this version reads format ${VAULT_FORMAT} only, which a 0.7.x lays it out in: install ${EARLIER_FLOOR.take} first.\n` +
        crossTheFloor("it lays the vault out by month", true),
    );
  }
  throw new VaultFormatError(
    `refusing to start: the memory vault is format ${found.format}, and this build reads format ${VAULT_FORMAT} (${vault.formatFile} says so).\n` +
      `A newer Nouride has already written it in a shape this build does not know; an update that was rolled back leaves exactly this.\n` +
      `  → start the newer build again, or\n` +
      `  → put ${vault.root} back as it was before that upgrade, from a snapshot in ${snapshots}`,
  );
}

/** Say in the vault which format it is in. */
export async function markVault(vault: Vault, format: number): Promise<void> {
  await writeSide(vault.formatFile, () => `{"format": ${format}}\n`);
}
