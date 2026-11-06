/**
 * The promise, or its signal's reason the moment the signal aborts — for a call that might not be listening.
 *
 * A fetch implementation that ignores its signal still has to stop when it fires: a web search and an attachment
 * download each wrote this for themselves.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
