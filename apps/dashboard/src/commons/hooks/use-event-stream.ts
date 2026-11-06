/**
 * The conversation's events, as the daemon writes them (`/events/stream`): each wakes the live poll, and what is news
 * for other parts of the page — an approval about to be asked, a turn ended — refetches them (`lib/stream.ts`). A
 * browser without `EventSource`, or a stream that does not open, leaves the polling as it was: the stream makes the
 * page sooner, never necessary.
 *
 * Open only while the tab is looked at. Over HTTP/1.1 a browser allows six connections to one host, and every open
 * stream holds one for as long as it lives: five chat tabs queued every other request behind theirs, and the dashboard
 * looked frozen. A hidden tab closes its stream; looked at again, it opens a new one from now, and the poll it wakes
 * catches up on what came in between.
 *
 * A browser retries a stream that dropped, never one that was refused — a daemon still starting answers 503 for a few
 * seconds, longer than the stream's 3 s retry — so a refused one is opened again here, later each time, and at once
 * when the tab is looked at again.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { rowEffects } from "@/commons/lib/event-stream";
import { usePageVisible } from "@/commons/hooks/use-page-visible";

/** A stream the daemon refused is opened again after this, doubling up to the second — never given up on. */
const REOPEN_MS = 2_000;
const REOPEN_MAX_MS = 30_000;

export function useEventStream(input: { chatId?: string; gatewayId?: string; wake: () => void }): { streaming: boolean } {
  const { chatId, gatewayId } = input;
  const queryClient = useQueryClient();
  const visible = usePageVisible();
  const [streaming, setStreaming] = useState(false);
  const [reopened, setReopened] = useState(0);
  const reopenIn = useRef(REOPEN_MS);
  const wake = useRef(input.wake);
  wake.current = input.wake;

  useEffect(() => {
    if (!chatId || !visible || typeof EventSource === "undefined") return;
    const source = new EventSource(api.eventStreamUrl({ chatId, ...(gatewayId ? { gatewayId } : {}) }));
    let retry: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => {
      setStreaming(true);
      reopenIn.current = REOPEN_MS;
    };
    source.onerror = () => {
      setStreaming(false);
      if (source.readyState !== EventSource.CLOSED || retry) return;
      retry = setTimeout(() => setReopened((n) => n + 1), reopenIn.current);
      reopenIn.current = Math.min(reopenIn.current * 2, REOPEN_MAX_MS);
    };
    source.onmessage = (event) => {
      const effects = rowEffects(event.data);
      if (effects.wakes) wake.current();
      for (const queryKey of effects.refresh) void queryClient.invalidateQueries({ queryKey: [...queryKey] });
    };
    return () => {
      clearTimeout(retry);
      source.close();
      setStreaming(false);
    };
  }, [chatId, gatewayId, reopened, visible, queryClient]);

  // Looked at again: a refused stream is tried at once rather than when its backoff says, and the poll catches up.
  useEffect(() => {
    if (!visible) return;
    reopenIn.current = REOPEN_MS;
    wake.current();
  }, [visible]);

  return { streaming };
}
