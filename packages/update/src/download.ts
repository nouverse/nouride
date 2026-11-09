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
 * ## A transfer that stops moving is picked up again
 *
 * A connection can go quiet without closing: headers that never come, or a body that stops at some byte and holds
 * the socket open. With nothing to end it the status stayed "downloading" for ever, and a second press of Update
 * returned that same status (a phone's update sat at 0 bytes until someone noticed). Each try is watched: no headers,
 * or no new bytes, for `STALL_MS` cuts it, and it is tried again from what is on disk, a few times, before it fails
 * with a plain sentence. A pause is still not a failure.
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
  /** How long a try may go without headers or new bytes before it is cut (`STALL_MS`); a test passes less. */
  stallMs?: number;
  /** The pauses before each try again (`RETRY_WAITS_MS`); a test passes none. */
  retryWaitsMs?: readonly number[];
}

/** No headers, or no new bytes, for this long and a try is cut: a release asset streams far faster than this. */
const STALL_MS = 30_000;
/** Five tries in about forty seconds of waiting, each going on from what is on disk. */
const RETRY_WAITS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000];

/** A failure worth another try: the transfer stopped moving, the connection broke, or the server failed for a moment. */
class PassingFailure extends Error {
  override name = "PassingFailure";
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  /** Tries until the file is whole, the person pauses, or a failure is not one to try again; then says how many it took. */
  private async pump(request: DownloadRequest, path: string): Promise<void> {
    const waits = request.retryWaitsMs ?? RETRY_WAITS_MS;
    const stallMs = request.stallMs ?? STALL_MS;
    for (let tries = 1; ; tries += 1) {
      try {
        await this.attempt(request, path, stallMs);
        return;
      } catch (error) {
        if (this.paused()) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        if (tries > waits.length || !(failure instanceof PassingFailure)) {
          throw tries > 1 ? new Error(`${failure.message}, ${tries} tries`) : failure;
        }
      }
      await wait(waits[tries - 1]!);
      if (this.paused()) return;
    }
  }

  /** Read afresh each time: a pause can come during any wait, which a narrowed `this.status` would not see. */
  private paused(): boolean {
    return this.status === "paused";
  }

  /** One try: from what is on disk to the end, cut when it goes `stallMs` without headers or bytes. */
  private async attempt(request: DownloadRequest, path: string, stallMs: number): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.received > 0) headers.range = `bytes=${this.received}-`;

    // Its own controller, so a stall ends this try alone; a pause ends it too, through the transfer's.
    const tryAbort = new AbortController();
    const onPause = () => tryAbort.abort();
    this.abort?.signal.addEventListener("abort", onPause, { once: true });
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        tryAbort.abort();
      }, stallMs);
    };
    const why = (error: unknown): Error => {
      if (stalled) return new PassingFailure(`downloading ${request.url} stopped moving: nothing came for ${Math.round(stallMs / 1000)} s`);
      if (this.status === "paused") return error instanceof Error ? error : new Error(String(error));
      return new PassingFailure(`downloading ${request.url} failed: ${error instanceof Error ? error.message : String(error)}`);
    };

    arm();
    try {
      let response: Response;
      try {
        response = await request.fetchImpl(request.url, { headers, signal: tryAbort.signal });
      } catch (error) {
        throw why(error);
      }
      if (!response.ok) {
        const said = `downloading ${request.url} answered ${response.status}`;
        throw response.status === 429 || response.status >= 500 ? new PassingFailure(said) : new Error(said);
      }
      arm();

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
          arm();
          const bytes = chunk as Uint8Array;
          await file.write(bytes);
          this.received += bytes.byteLength;
        }
      } catch (error) {
        throw why(error);
      } finally {
        await file.close();
      }
      // A body that ended early is a try that broke: the length said more was coming.
      if (this.total !== null && this.received < this.total && this.status !== "paused") {
        throw new PassingFailure(`downloading ${request.url} ended at ${this.received} of ${this.total} bytes`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.abort?.signal.removeEventListener("abort", onPause);
    }

    if (this.status === "paused") return;
    this.total = this.received;
    this.status = "ready";
  }
}

function sizeOf(path: string | null): number {
  return path ? (statFile(path)?.size ?? 0) : 0;
}
