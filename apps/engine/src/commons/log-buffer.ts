/**
 * The recent log, in memory, so `nouride logs` works everywhere.
 *
 * ## Why not a file
 *
 * The systemd unit says it plainly: *"Journal, not a file: rotation and retention are then the
 * system's problem rather than ours."* That decision is right and this does not overturn it — a log
 * file means inventing rotation, and a daemon that fills a disk with its own logs is a worse failure
 * than one that cannot show you the last hour.
 *
 * ## Why anything at all, then
 *
 * Because the journal is not everywhere. Every debugging step in this project so far has gone through
 * `journalctl -u nouride`, which works only under systemd: Docker, macOS launchd and an LXC without
 * systemd each have something different or nothing. And none of them work *remotely* — reading the log
 * meant having SSH to the box.
 *
 * So: a bounded ring of recent entries, readable over the control API. It covers the window debugging
 * actually uses, on every platform, without owning retention. Anything older is still the platform's
 * job, and `nouride logs` says so rather than pretending the buffer is the whole history.
 *
 * ## Bounded by construction
 *
 * A fixed-size ring, not a list that is trimmed later. A daemon that logs its way out of memory during
 * an incident is the one thing this must never do — and incidents are exactly when log volume spikes.
 */

import { addLogSink, type LogEntry, type LogLevel } from "@nouride/shared";

/**
 * Entries kept.
 *
 * Two thousand covers a long turn with tool calls, a reconnect storm, and a full boot sequence — the
 * three things anyone scrolls back through. At roughly 200 bytes each that is a few hundred KB, which
 * is nothing next to the 64MB floor this daemon already assumes.
 */
const CAPACITY = 2000;

export interface LogQuery {
  /** Newest N entries. Capped at the buffer size. */
  limit?: number;
  /** Only this level and above, in the order debug < info < warn < error. */
  minLevel?: LogLevel;
  /** Only this component, matched exactly — `gateway.telegram:bot`, `pipeline`, `tools.mcp`. */
  component?: string;
  /** Entries newer than this sequence number. What a follower polls with. */
  since?: number;
}

/** A stored entry, plus the sequence a follower uses to ask for what it has not seen. */
export interface BufferedLog extends LogEntry {
  seq: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class LogBuffer {
  private readonly entries: (BufferedLog | undefined)[];
  private next = 0;
  private seq = 0;

  constructor(private readonly capacity: number = CAPACITY) {
    this.entries = new Array<BufferedLog | undefined>(capacity);
  }

  /**
   * Start recording.
   *
   * Registered as a sink rather than replacing the logger: entries still reach stdout, so the journal,
   * Docker and launchd keep the full history. This is a second reader, never the only one.
   */
  attach(): void {
    addLogSink((entry) => this.record(entry));
  }

  record(entry: LogEntry): void {
    this.seq += 1;
    this.entries[this.next] = { ...entry, seq: this.seq };
    this.next = (this.next + 1) % this.capacity;
  }

  /** Oldest sequence still held, so a caller can tell whether it has fallen behind. */
  oldestSeq(): number {
    return Math.max(1, this.seq - this.capacity + 1);
  }

  latestSeq(): number {
    return this.seq;
  }

  /** Newest last, which is the order a person reads a log in. */
  query(options: LogQuery = {}): BufferedLog[] {
    const floor = options.minLevel ? LEVEL_ORDER[options.minLevel] : 0;

    const all: BufferedLog[] = [];
    // Walked from the oldest slot so the result is already in order — sorting afterwards would be
    // the same work plus a comparison per entry.
    for (let i = 0; i < this.capacity; i++) {
      const entry = this.entries[(this.next + i) % this.capacity];
      if (!entry) continue;
      if (options.since !== undefined && entry.seq <= options.since) continue;
      if (LEVEL_ORDER[entry.level] < floor) continue;
      if (options.component && entry.component !== options.component) continue;
      all.push(entry);
    }

    const limit = options.limit ?? 100;
    return limit > 0 ? all.slice(-limit) : all;
  }
}
