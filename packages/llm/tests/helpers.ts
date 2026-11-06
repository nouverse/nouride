/** Fake fetch, so provider tests exercise the real wire mapping without a network. */

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

export interface FakeFetch {
  fn: typeof fetch;
  requests: RecordedRequest[];
  last(): RecordedRequest;
}

type Responder = (req: RecordedRequest, attempt: number) => Response;

export function fakeFetch(responder: Responder | Response): FakeFetch {
  const requests: RecordedRequest[] = [];

  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const record: RecordedRequest = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    requests.push(record);
    return typeof responder === "function"
      ? responder(record, requests.length - 1)
      : responder.clone();
  }) as unknown as typeof fetch;

  return {
    fn,
    requests,
    last() {
      const last = requests.at(-1);
      if (!last) throw new Error("no request was made");
      return last;
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An SSE response whose body is delivered as several chunks, as a real one would be. */
export function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

/** Never actually wait out a backoff in a test. */
export const noSleep = async (): Promise<void> => {};
