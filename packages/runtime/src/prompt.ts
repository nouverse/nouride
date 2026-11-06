/**
 * Reading a line from a person (TD-001).
 *
 * The CLI asks two kinds of question — an ordinary one and one whose answer must not appear on
 * screen — and both used to be assembled at the call site out of `node:readline` and a hand-rolled
 * `Writable`. That put the mechanism for hiding a provider key inside a setup wizard, where the next
 * person to simplify it would not know what it was load-bearing for.
 */

import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { contained, createLogger } from "@nouride/shared";

const log = createLogger("runtime.prompt");

/**
 * A stdout that can be switched off.
 *
 * Readline echoes what is typed by writing it to its `output`. Giving it this instead of
 * `process.stdout` is what makes a hidden prompt possible without a second reader on stdin — see
 * `askHidden` for the three-way failure that caused.
 *
 * `isTTY` and the dimensions are forwarded because readline consults them to decide whether to do
 * line editing at all; a plain `Writable` would make it treat a real terminal as a pipe.
 */
export class MuteableOutput extends Writable {
  muted = false;
  readonly isTTY = process.stdout.isTTY;

  get columns(): number | undefined {
    return process.stdout.columns;
  }

  get rows(): number | undefined {
    return process.stdout.rows;
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) process.stdout.write(chunk as Uint8Array);
    callback();
  }
}

export interface LinePrompt {
  /** Ask, and return what was typed. */
  ask(question: string): Promise<string>;
  /**
   * Ask without the answer appearing on screen.
   *
   * `question` writes the prompt synchronously and only then returns its promise, so muting on the
   * next line hides the typing without hiding the label. Muting first would hide both.
   */
  askHidden(question: string): Promise<string>;
  /** Ctrl-D, or the terminal going away. */
  onClose(handler: () => void): void;
  close(): void;
  /** The underlying readline, for the one caller that needs to hand it to something else. */
  readonly raw: Interface;
}

/** Where a prompt reads and writes: the process's own unless a test hands it others. */
export interface LinePromptIO {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: { write(chunk: string): unknown };
}

export function openLinePrompt(io: LinePromptIO = {}): LinePrompt {
  const input = io.input ?? process.stdin;
  if (!input.isTTY) return scriptedPrompt(input, io.output ?? process.stdout);
  const output = new MuteableOutput();
  // `terminal: true` explicitly: readline decides by inspecting `output.isTTY`, and a custom stream
  // that answered wrongly would leave the prompt unable to edit a line or hide one.
  const rl = createInterface({ input, output, terminal: true });

  return {
    raw: rl,
    ask: (question) => rl.question(question),
    askHidden: async (question) => {
      const pending = rl.question(question);
      output.muted = true;
      try {
        return await pending;
      } finally {
        output.muted = false;
        // The newline the operator typed was swallowed along with the key, so without this the next
        // line starts against the prompt.
        process.stdout.write("\n");
      }
    },
    onClose: (handler) => {
      rl.on("close", contained(log, "could not finish after the input closed", handler));
    },
    close: () => rl.close(),
  };
}

/**
 * Lines a script pipes in, each handed to one question, in order.
 *
 * `question()` receives only a line that arrives while it is waiting. A script's lines arrive together, while its
 * first message is still being answered, so readline handed the rest to nobody and closed: `nouride chat` answered
 * the first line of a script and ended. A last line with no newline came with the close, after the question waiting
 * for it was dropped, and that chat never ended at all. Here each line is queued as it arrives, a question takes the
 * oldest, and one asked after the last line is refused, as a closed readline's is.
 *
 * Not a terminal, so nothing is echoed as it arrives: a line is written after the question that takes it — a hidden
 * one's is not — and a transcript reads in the order the conversation went.
 */
function scriptedPrompt(input: NodeJS.ReadableStream, output: { write(chunk: string): unknown }): LinePrompt {
  const rl = createInterface({ input, terminal: false });
  const lines: string[] = [];
  const waiting: { take: (line: string) => void; refuse: (err: Error) => void }[] = [];
  let ended = false;
  rl.on(
    "line",
    contained(log, "could not take a line of input", (line: string) => {
      const next = waiting.shift();
      if (next) next.take(line);
      else lines.push(line);
    }),
  );
  rl.on(
    "close",
    contained(log, "could not end the questions still waiting", () => {
      ended = true;
      for (const next of waiting.splice(0)) next.refuse(new Error("the input ended"));
    }),
  );

  // A question past the last line is not written: the transcript would end on a prompt nothing answers.
  const next = (question: string): Promise<string> => {
    const line = lines.shift();
    if (line === undefined && ended) return Promise.reject(new Error("the input ended"));
    output.write(question);
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((take, refuse) => waiting.push({ take, refuse }));
  };

  return {
    raw: rl,
    ask: async (question) => {
      const line = await next(question);
      output.write(`${line}\n`);
      return line;
    },
    askHidden: async (question) => {
      const line = await next(question);
      output.write("\n");
      return line;
    },
    onClose: (handler) => {
      rl.on("close", contained(log, "could not finish after the input closed", handler));
    },
    close: () => rl.close(),
  };
}
