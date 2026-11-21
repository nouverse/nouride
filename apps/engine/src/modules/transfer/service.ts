/**
 * Export and import as the running daemon does them, for the page in Settings.
 *
 * An export is made here as the command makes it, in the background, into a folder of the data folder, and downloaded
 * from there: one at a time, the last one kept until the next. An import arrives in pieces (a request's body has a
 * ceiling far under an install's size), is opened and checked here with the passphrase, and is then left ready for the
 * next start (`boot/staged-import.ts`): the daemon cannot replace what it is running on. "Go live" turns the mark an
 * import left; the connections come with the restart it asks for, the scheduler at once.
 */

import { ensureDir, freeDiskBytes, join, listDir, openFileWriter, removePath, statFile } from "@nouride/runtime";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import type { ExportPlan, ExportStatus, ImportChecked, ImportReport, TransferState } from "@nouride/wire";
import { forgetImportFailure, importStaged, installFolder, lastImportFailure, stageImport, stagingOf, unstageImport } from "@/boot/staged-import.ts";
import type { StateRows } from "@/commons/daemon-state.store.ts";
import { exportPlan, placesOf, writeExport, type HoldsCredential, type SnapshotSource } from "./archive.ts";
import { heldBack, importedOf, markLive } from "./held.ts";
import { openImport, type ImportRefusal, type OpenedImport } from "./import.ts";

const log = createLogger("transfer");

/** The shortest passphrase an export's secrets are sealed to, as the backup password's. */
export const PASSPHRASE_MIN = 12;

/** The word that confirms an import, typed: it replaces everything. */
export const CONFIRM_WORD = "replace";

export interface TransferDeps {
  config: () => GlobalConfig;
  configPath: string;
  db: SnapshotSource;
  state: StateRows;
  version: string;
  agents: () => string[];
  /** What stays out of an agent's folder in an export: the rule Files lists by. */
  credential: HoldsCredential;
  /** The secret store as the daemon holds it: the text an export seals. */
  secrets: { sealedCopyText(): string };
  /** Whether something starts Nouride again when it stops, and stopping it. Absent: it cannot restart itself. */
  restart?: { can(): boolean; now(reason: string): void };
  scheduler?: { start(): void };
  now?: () => number;
}

export class Transfer {
  private exporting: ExportStatus = { state: "none" };
  private opened: OpenedImport | null = null;

  constructor(private readonly deps: TransferDeps) {}

  private get data(): string {
    return this.deps.config().daemon.dataDir;
  }
  private get exportDir(): string {
    return join(this.data, "export");
  }
  private get uploadPath(): string {
    return join(installFolder(this.data), "import-upload.tar.gz");
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private secretCount(): number {
    return Object.keys((JSON.parse(this.deps.secrets.sealedCopyText()) as { secrets?: object }).secrets ?? {}).length;
  }

  state(): TransferState {
    const upload = statFile(this.uploadPath);
    return {
      export: this.exportStatus(),
      upload: upload ? { bytes: upload.size } : null,
      imported: importedOf(this.deps.state),
      restarts: this.deps.restart?.can() ?? false,
      failed: lastImportFailure(this.data),
      staged: importStaged(this.data),
      held: heldBack(this.deps.state),
    };
  }

  plan(folders: boolean): ExportPlan {
    const plan = exportPlan({ config: this.deps.config(), configPath: this.deps.configPath, dbPath: join(this.data, "nouride.db"), folders, credential: this.deps.credential });
    ensureDir(this.exportDir, 0o700);
    return { ...plan, secrets: this.secretCount(), freeBytes: freeDiskBytes(this.exportDir) };
  }

  /** The last export, as it stands: one made by an earlier run of the daemon is found on disk. */
  private exportStatus(): ExportStatus {
    if (this.exporting.state !== "none") return this.exporting;
    const [last] = listDir(this.exportDir).filter((entry) => entry.isFile && entry.name.endsWith(".tar.gz"));
    const stat = last ? statFile(join(this.exportDir, last.name)) : null;
    return last && stat ? { state: "ready", name: last.name, bytes: stat.size, madeAt: stat.mtimeMs } : { state: "none" };
  }

  exportFile(): { path: string; name: string; bytes: number } | null {
    const status = this.exportStatus();
    return status.state === "ready" && status.name ? { path: join(this.exportDir, status.name), name: status.name, bytes: status.bytes ?? 0 } : null;
  }

  /**
   * An export begun, in the background. `passphrase` null: no secrets go in. Refused while one is being made, and for a
   * passphrase too short to stand between a lost file and every credential.
   */
  startExport(asked: { passphrase: string | null; folders: boolean }): { ok: true } | { ok: false; why: "busy" | "short"; error: string } {
    if (this.exporting.state === "working") return { ok: false, why: "busy", error: "an export is being made" };
    // A store that holds nothing has nothing to seal, whatever was typed.
    const count = this.secretCount();
    const passphrase = count > 0 ? asked.passphrase : null;
    if (passphrase !== null && passphrase.length < PASSPHRASE_MIN) {
      return { ok: false, why: "short", error: `the passphrase is shorter than ${PASSPHRASE_MIN} characters` };
    }
    const config = this.deps.config();
    const total = exportPlan({ config, configPath: this.deps.configPath, dbPath: join(this.data, "nouride.db"), folders: asked.folders, credential: this.deps.credential }).bytes;
    removePath(this.exportDir);
    ensureDir(this.exportDir, 0o700);
    const name = `nouride-export-${new Date(this.now()).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.tar.gz`;
    const store = passphrase === null ? null : this.deps.secrets.sealedCopyText();
    this.exporting = { state: "working", done: { files: 0, bytes: 0 }, total };
    void writeExport({
      config,
      configPath: this.deps.configPath,
      db: this.deps.db,
      version: this.deps.version,
      agents: this.deps.agents(),
      out: join(this.exportDir, name),
      work: join(this.exportDir, "work"),
      folders: asked.folders,
      credential: this.deps.credential,
      ...(passphrase !== null && store !== null ? { secrets: { passphrase, store, count } } : {}),
      now: () => this.now(),
      onProgress: (done) => {
        if (this.exporting.state === "working") this.exporting = { ...this.exporting, done: { ...done } };
      },
    })
      .then((made) => {
        removePath(join(this.exportDir, "work"));
        this.exporting = made.ok
          ? { state: "ready", name, bytes: made.bytes, madeAt: made.manifest.madeAt, secrets: made.manifest.secrets !== null, folders: made.manifest.folders }
          : { state: "failed", error: made.error };
        if (made.ok) log.info("an export was made", { name, bytes: made.bytes, secrets: made.manifest.secrets, folders: made.manifest.folders });
        else log.error("an export could not be made", { error: made.error });
      })
      .catch((err: unknown) => {
        this.exporting = { state: "failed", error: String(err) };
      });
    return { ok: true };
  }

  /** The last export removed: the file holds every chat and memory, and stays only as long as it is wanted. */
  dropExport(): void {
    if (this.exporting.state === "working") return;
    removePath(this.exportDir);
    this.exporting = { state: "none" };
  }

  /**
   * A piece of a file for import, written at `at`: 0 begins a new file, and any other must be where the last piece
   * ended, so a piece sent twice or out of turn is refused and not written into the middle. How much has arrived.
   */
  async upload(at: number, bytes: Uint8Array): Promise<{ ok: true; bytes: number } | { ok: false; error: string; bytes: number }> {
    const have = at === 0 ? 0 : (statFile(this.uploadPath)?.size ?? 0);
    if (at !== have) return { ok: false, error: `this piece starts at ${at}, and ${have} bytes have arrived`, bytes: have };
    if (at === 0) {
      this.opened = null;
      unstageImport(this.data);
      forgetImportFailure(this.data);
      removePath(this.uploadPath);
    }
    const writer = openFileWriter(this.uploadPath, { append: at > 0, mode: 0o600 });
    try {
      await writer.write(bytes);
    } finally {
      await writer.close();
    }
    return { ok: true, bytes: have + bytes.length };
  }

  /** The uploaded file opened and checked (`openImport`): what it holds beside what is here, or why it is refused. */
  async check(passphrase: string | undefined): Promise<ImportChecked | ImportRefusal> {
    this.opened = null;
    if (!statFile(this.uploadPath)) return { ok: false, why: "not-an-export", error: "no file was uploaded", plain: "No file was uploaded." };
    const opened = await openImport({ file: this.uploadPath, staging: stagingOf(this.data), passphrase, version: this.deps.version });
    if (!opened.ok) return opened;
    this.opened = opened;
    const config = this.deps.config();
    const { manifest } = opened;
    const here = exportPlan({ config, configPath: this.deps.configPath, dbPath: join(this.data, "nouride.db"), folders: manifest.folders, credential: this.deps.credential });
    const people = placesOf(config, this.deps.configPath, false).find((place) => place.name === "config/people");
    return {
      version: manifest.version,
      madeAt: manifest.madeAt,
      agents: manifest.agents,
      secrets: manifest.secrets,
      folders: manifest.folders,
      database: manifest.database.bytes,
      parts: manifest.parts,
      here: { agents: this.deps.agents(), people: people ? listDir(people.path).filter((entry) => entry.isFile && entry.name.endsWith(".toml")).length : 0, bytes: here.bytes },
    };
  }

  /**
   * The checked file left ready, and the restart that applies it asked for. `restarting` false: nothing here starts
   * Nouride again, so it is the person's to restart, and the import goes in when they do.
   */
  apply(by: string): { ok: true; restarting: boolean } | { ok: false; error: string } {
    if (!this.opened) return { ok: false, error: "no checked file to import" };
    stageImport(this.data, this.opened, by, this.now());
    this.opened = null;
    log.info("an import was left ready for the next start", { by });
    const restarting = this.deps.restart?.can() ?? false;
    if (restarting) this.deps.restart!.now("an import was asked for");
    return { ok: true, restarting };
  }

  /** An import taken back before it was applied, its file with it. */
  cancel(): void {
    this.opened = null;
    unstageImport(this.data);
    removePath(this.uploadPath);
  }

  /**
   * "Go live": the mark turned, the scheduler started, and the restart that brings the connections asked for where
   * there are any to bring. Null for an install that was never imported.
   */
  goLive(by: string): { report: ImportReport; restarting: boolean; restart: boolean } | null {
    const was = heldBack(this.deps.state);
    const report = markLive(this.deps.state);
    if (!report) return null;
    removePath(this.uploadPath);
    if (!was) return { report, restarting: false, restart: false };
    log.info("an imported install went live", { by, connections: report.held.connections.length, automations: report.held.automations });
    this.deps.scheduler?.start();
    const restart = report.held.connections.length > 0;
    const restarting = restart && (this.deps.restart?.can() ?? false);
    if (restarting) this.deps.restart!.now("an imported install went live");
    return { report, restarting, restart };
  }

  /** The note of an import put away, once it is live: the page stops showing it. */
  putAway(): boolean {
    const imported = importedOf(this.deps.state);
    if (!imported?.live) return false;
    this.deps.state.set("imported", "null");
    return true;
  }
}
