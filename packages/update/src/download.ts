/**
 * Fetching a release tarball in a way a person can stop and pick up again.
 *
 * ## Why this is not one `await fetch(...).arrayBuffer()`
 *
 * Because of where it runs. A 43 MB download on a Raspberry Pi over a home connection takes
 * about half a minute, and on a worse link it takes minutes — long enough that somebody
 * watching a dashboard needs to see it move, and long enough that "not now" is a real answer.
 * Buffering the whole body also means holding 43 MB of it in a daemon whose memory budget is
 * the reason this project exists.
 *
 * So it streams to a `.part` file beside the install, reports progress as it goes, and can be
 * paused. Resuming sends `Range: bytes=<what is on disk>-` and appends; a server that ignores
 * the range and replies 200 is detected by the status code and the file is started again
 * rather than being appended to and silently corrupted.
 *
 * ## Downloading is not installing
 *
 * Nothing here touches the running install. The `.part` becomes a whole file and stops there;
 * verifying it and swapping it in is a separate decision, taken by a separate call, because
 * that is the one that ends the process.
 */

import { ensureDir, join, openFileWriter, removePath, statFile } from "@nouride/runtime";

export type DownloadStatus = "idle" | "downloading" | "paused" | "ready" | "failed";

export interface DownloadSnapshot {
  status: DownloadStatus;
  /** Bytes on disk. Survives a pause, and is where a resume continues from. */
  received: number;
  /** Total, when the server said. Null for a response with no length. */
  total: number | null;
  /** Which release this is for, so a stale `.part` from an older tag is never installed. */
  tag: string | null;
  artifact: string | null;
  /** The finished file, once `status` is `ready`. */
  path: string | null;
  error: string | null;
}

export interface DownloadRequest {
  installDir: string;
  url: string;
  tag: string;
  artifact: string;
  fetchImpl: typeof fetch;
}

/** Where a partly-downloaded release waits. One directory, cleared when a different tag arrives. */
export function stagingDir(installDir: string): string {
  return join(installDir, ".nouride-update");
}

/**
 * One download at a time, held by the daemon for as long as the process lives.
 *
 * Deliberately in memory rather than in the database: a `.part` file that outlives a restart is
 * resumable by looking at it, and a *status* that outlives a restart would claim a transfer is
 * running when the thing running it is gone.
 */
export class ReleaseDownload {
  private status: DownloadStatus = "idle";
  private received = 0;
  private total: number | null = null;
  private tag: string | null = null;
  private artifact: string | null = null;
  private error: string | null = null;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;

  snapshot(): DownloadSnapshot {
    return {
      status: this.status,
      received: this.received,
      total: this.total,
      tag: this.tag,
      artifact: this.artifact,
      path: this.status === "ready" ? this.partPath() : null,
      error: this.error,
    };
  }

  private partPath(): string | null {
    if (!this.dir || !this.artifact) return null;
    return join(this.dir, `${this.artifact}.tar.gz`);
  }

  private dir: string | null = null;

  /**
   * Start, or continue where a pause left off.
   *
   * Idempotent while running: a second press of the button is not a second transfer. A request
   * for a *different* tag throws away whatever was on disk, because appending one release to
   * another produces a file that passes no checksum and explains nothing.
   */
  async start(request: DownloadRequest): Promise<DownloadSnapshot> {
    if (this.status === "downloading") return this.snapshot();

    const changed = this.tag !== request.tag || this.artifact !== request.artifact;
    this.dir = stagingDir(request.installDir);
    ensureDir(this.dir);
    if (changed) {
      removePath(this.dir);
      ensureDir(this.dir);
      this.received = 0;
      this.total = null;
    }
    this.tag = request.tag;
    this.artifact = request.artifact;
    this.error = null;

    const path = this.partPath()!;
    this.received = sizeOf(path);
    if (this.total !== null && this.received >= this.total && this.total > 0) {
      this.status = "ready";
      return this.snapshot();
    }

    this.status = "downloading";
    this.abort = new AbortController();
    this.running = this.pump(request, path).catch((err: unknown) => {
      // An abort is a pause, not a failure: the distinction is the whole point of the button.
      if (this.status === "paused") return;
      this.status = "failed";
      this.error = err instanceof Error ? err.message : String(err);
    });
    return this.snapshot();
  }

  /** Stop, keeping what is on disk. */
  pause(): DownloadSnapshot {
    if (this.status !== "downloading") return this.snapshot();
    this.status = "paused";
    this.abort?.abort();
    return this.snapshot();
  }

  /** Throw away the part file and forget the transfer. */
  async discard(): Promise<DownloadSnapshot> {
    this.pause();
    if (this.dir) removePath(this.dir);
    this.status = "idle";
    this.received = 0;
    this.total = null;
    this.tag = null;
    this.artifact = null;
    this.error = null;
    return this.snapshot();
  }

  /** For the one-shot path, and for tests: wait for the transfer in flight. */
  async settle(): Promise<DownloadSnapshot> {
    if (this.running) await this.running;
    return this.snapshot();
  }

  private async pump(request: DownloadRequest, path: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.received > 0) headers.range = `bytes=${this.received}-`;

    const response = await request.fetchImpl(request.url, {
      headers,
      signal: this.abort?.signal ?? null,
    });
    if (!response.ok) throw new Error(`downloading ${request.url} answered ${response.status}`);

    /**
     * A server that ignored the range answers 200 with the whole file.
     *
     * Appending that to what is already on disk produces a file of the right size for nothing
     * and a checksum failure with no explanation, so the partial is dropped and this becomes a
     * fresh transfer.
     */
    const resuming = this.received > 0 && response.status === 206;
    if (this.received > 0 && !resuming) {
      removePath(path);
      this.received = 0;
    }

    const length = Number(response.headers.get("content-length") ?? "");
    this.total = Number.isFinite(length) && length > 0 ? this.received + length : this.total;

    const body = response.body;
    if (!body) throw new Error("the release channel returned no body");

    const file = openFileWriter(path, { append: resuming });
    try {
      for await (const chunk of body) {
        const bytes = chunk as Uint8Array;
        await file.write(bytes);
        this.received += bytes.byteLength;
      }
    } finally {
      await file.close();
    }

    if (this.status === "paused") return;
    this.total = this.received;
    this.status = "ready";
  }
}

function sizeOf(path: string | null): number {
  return path ? (statFile(path)?.size ?? 0) : 0;
}
