/**
 * Editing an agent's own files from the browser.
 *
 * These are the files that decide who an agent is — `SOUL.md` is its personality, `config.toml` is its
 * model and its tool permissions. Handing that to an HTTP route needs three things the tool sandbox
 * already learned the hard way:
 *
 * - **An allowlist, not a path.** The route takes a file *name* from a fixed set, resolved against one
 *   agent directory. Accepting a path and validating it means being right about traversal every time;
 *   accepting a name from a list means being right once.
 * - **Validation before the write lands.** A `config.toml` that does not parse takes the agent offline
 *   at the next reload, and the operator finds out from a blank agent list rather than from the editor
 *   that broke it.
 * - **The same lock the tools take.** The agent may be writing `MEMORY.md` while the operator saves it
 *   in another tab.
 *
 * Backups rotate on every write, the same as `memory_write`. These files are kilobytes and they are
 * the least reproducible thing in the installation.
 */

import { join, readTextFileIfExists, resolveWithin, statFile, writeTextFileAtomic } from "@nouride/runtime";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import type { AuditPort } from "@/commons/audit.store.ts";
import { withFileLock } from "@/commons/file-lock.ts";
import { rotateBackups } from "@/commons/backups.ts";
import { editDaemonConfig, tomlProblem } from "@/modules/config/config-file.ts";

const log = createLogger("setup.files");

/**
 * What may be edited, and what each file is for.
 *
 * `MEMORY.md` is included deliberately, and it is the one to be careful with: it is the agent's own
 * accumulated identity and the only file here that exists nowhere else — not in git, not in the image.
 * An operator who wants to correct something the agent remembered wrongly has no other way to do it,
 * and telling them to use a shell is exactly the outcome this surface exists to avoid.
 */
const EDITABLE_AGENT_FILES = [
  { name: "IDENTITY.md", label: "Identity", description: "Name and role. The one file an agent cannot start without." },
  { name: "SOUL.md", label: "Soul", description: "Personality, tone, and behaviour rules." },
  { name: "AGENTS.md", label: "Agents", description: "What this agent knows about the others." },
  { name: "MEMORY.md", label: "Memory", description: "What the agent has remembered. It writes this itself." },
  { name: "config.toml", label: "Config", description: "Model, tools, permissions and workspace roots." },
] as const;

export type EditableFileName = (typeof EDITABLE_AGENT_FILES)[number]["name"];

/** Generous for markdown, and small enough that a paste accident cannot fill the disk. */
const MAX_FILE_BYTES = 512 * 1024;

export interface FileSummary {
  name: string;
  label: string;
  description: string;
  exists: boolean;
  bytes: number;
  modifiedAt: number | null;
}

export interface FileServiceDeps {
  agentsDir: string;
  /**
   * The daemon's config file, as the loader resolved it — never derived here.
   *
   * This was `dataDir` and the path was computed as `<dataDir>/config.toml`, which is a *different
   * file* on any install where the data directory is set: the real config lives at
   * `<root>/.nouride/config.toml` while data sits in `<root>/.nouride/data/`. The editor therefore
   * read a file that did not exist — an empty box, on a daemon with a 5 KB config — and a save
   * would have created a second config nothing loads.
   *
   * `paths.ts` fixed exactly this derivation for the setup wizard and the settings service; this was
   * the third copy of the same guess. See the note on `SettingsService.configPath` in
   * `boot/control-plane.ts`: one daemon, one answer to which file is its config.
   */
  configPath: string;
  registry: AgentRegistry;
  config: GlobalConfig;
  audit?: AuditPort;
}

export class FileService {
  constructor(private readonly deps: FileServiceDeps) {}

  /**
   * Resolve a name from the allowlist inside one agent's directory.
   *
   * `resolveWithin` on top of the allowlist rather than instead of it. The list already makes traversal
   * impossible; the resolve is what stops an agent id like `../other` from selecting a different pack.
   */
  private agentFilePath(agentId: string, name: string): string | null {
    if (!EDITABLE_AGENT_FILES.some((f) => f.name === name)) return null;
    try {
      const dir = resolveWithin(this.deps.agentsDir, agentId);
      return join(dir, name);
    } catch {
      return null;
    }
  }

  async listForAgent(agentId: string): Promise<FileSummary[] | null> {
    if (!this.deps.registry.get(agentId)) return null;

    const out: FileSummary[] = [];
    for (const file of EDITABLE_AGENT_FILES) {
      const path = this.agentFilePath(agentId, file.name);
      if (!path) continue;
      const stat = statFile(path);
      out.push({
        name: file.name,
        label: file.label,
        description: file.description,
        exists: stat !== null && !stat.isDirectory,
        bytes: stat?.size ?? 0,
        modifiedAt: stat?.mtimeMs ?? null,
      });
    }
    return out;
  }

  /** A file that does not exist reads as empty rather than as an error — the editor creates it. */
  async read(agentId: string, name: string): Promise<{ content: string } | { error: string }> {
    const path = this.agentFilePath(agentId, name);
    if (!path) return { error: `"${name}" is not an editable file.` };
    if (!this.deps.registry.get(agentId)) return { error: `No agent called "${agentId}".` };

    return { content: (await readTextFileIfExists(path)) ?? "" };
  }

  async write(input: {
    agentId: string;
    name: string;
    content: string;
    actor: string;
    /**
     * The text the edit started from, when the editor sends it. A file that changed since is refused
     * rather than overwritten: the agent writes `MEMORY.md` itself, and a tab left open since the
     * afternoon would otherwise erase whatever it kept in the meantime.
     */
    expected?: string;
    /** Said beside the file and its size in the audit entry: an agent's change says it came through `persona`, and why. */
    details?: Record<string, unknown>;
  }): Promise<{ ok: true; reloaded: boolean } | { ok: false; error: string; conflict?: true }> {
    const path = this.agentFilePath(input.agentId, input.name);
    if (!path) return { ok: false, error: `"${input.name}" is not an editable file.` };
    if (!this.deps.registry.get(input.agentId)) {
      return { ok: false, error: `No agent called "${input.agentId}".` };
    }
    if (input.content.length > MAX_FILE_BYTES) {
      return { ok: false, error: `That is over the ${MAX_FILE_BYTES / 1024}KB limit for these files.` };
    }
    if (input.name === "config.toml") {
      const problem = tomlProblem(input.content);
      if (problem) return { ok: false, error: `That config would not parse: ${problem}` };
    }
    if (input.name === "IDENTITY.md" && !input.content.trim()) {
      // The one file with no sensible default. An empty one fails the loader, which would take the
      // agent offline from inside the editor that was supposed to be fixing it.
      return { ok: false, error: "IDENTITY.md cannot be empty: the agent will not load without it." };
    }

    return await withFileLock(path, async () => {
      const previous = await readTextFileIfExists(path);
      if (input.expected !== undefined && (previous ?? "") !== input.expected) {
        return {
          ok: false as const,
          conflict: true as const,
          error: `${input.name} changed since you opened it. Reload it, then make your change again.`,
        };
      }
      if (previous !== null) await rotateBackups(path, previous);
      await writeTextFileAtomic(path, input.content);

      // Reloaded so the change is live, and rolled back if the pack no longer loads. A saved file that
      // takes the agent down is a worse outcome than a refused save, and the operator is right here.
      let reloaded = true;
      try {
        await this.deps.registry.reload(input.agentId);
      } catch (err) {
        if (previous !== null) await writeTextFileAtomic(path, previous);
        await this.deps.registry.reload(input.agentId).catch(() => {});
        return {
          ok: false as const,
          error: `Saved nothing: with that change the agent no longer loads. ${String(
            err instanceof Error ? err.message : err,
          )}`,
        };
      }

      log.info("agent file edited", { agent_id: input.agentId, file: input.name });
      this.deps.audit?.record({
        action: "agent_file_edited",
        agentId: input.agentId,
        actor: input.actor,
        details: { file: input.name, bytes: input.content.length, ...input.details },
      });
      return { ok: true as const, reloaded };
    });
  }

  // ── the daemon's own config ───────────────────────────────────────────────

  daemonConfigPath(): string {
    return this.deps.configPath;
  }

  async readDaemonConfig(): Promise<string> {
    return (await readTextFileIfExists(this.daemonConfigPath())) ?? "";
  }

  /**
   * Save the daemon config.
   *
   * Through the one checked write (`config/config-file.ts`): refused when the next boot would refuse it, not only when
   * it does not parse — a file the daemon will not start from is the one save the operator cannot undo from here.
   * The daemon does not hot-reload its own settings, so this reports honestly that a restart is needed rather than
   * pretending the change is live.
   */
  async writeDaemonConfig(
    content: string,
    actor: string,
    /**
     * The text the editor opened, when it sends it. A file that changed since is refused rather than overwritten: a
     * setting saved from a card meanwhile — or by an agent's `person_notes` — would otherwise be put back by a tab
     * left open since the afternoon, and come back at the next restart.
     */
    expected?: string,
  ): Promise<{ ok: true; restartRequired: true } | { ok: false; error: string; conflict?: true }> {
    let conflict = false;
    // No running copy follows it: a whole file may move `data_dir` or a gateway's token, which the daemon reads at boot,
    // and a running config saying so before the restart would describe a daemon that is not the one running.
    const saved = await editDaemonConfig(this.daemonConfigPath(), null, (current) => {
      if (expected === undefined || current === expected) return content;
      conflict = true;
      return { refused: "config.toml changed since you opened it. Reload it, then make your change again." };
    });
    if (!saved.ok) return { ok: false, error: saved.error, ...(conflict ? { conflict: true as const } : {}) };
    log.info("daemon config edited from the dashboard");
    this.deps.audit?.record({ action: "config_edited", actor, details: { bytes: content.length } });
    return { ok: true, restartRequired: true };
  }
}
