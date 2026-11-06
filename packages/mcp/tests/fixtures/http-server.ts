/**
 * The scripted server (`server.ts`) over Streamable HTTP, on a real socket — the way a remote MCP server is reached.
 *
 * One endpoint: POST carries the client's messages and answers each request as JSON; GET opens the stream the server
 * speaks on unasked, or is refused with 405; DELETE ends the session. Like a real server, what it says unasked goes to
 * an open GET stream and is lost when there is none. Every request is recorded with its headers, so a test can say what
 * the client sent and when.
 */

import { serveHttp } from "@nouride/runtime";
import { scriptedServer, type ServerScript } from "./server.ts";

export interface HttpScript extends ServerScript {
  /** Issue `Mcp-Session-Id` on `initialize`, and hold every later request to it. */
  sessions?: boolean;
  /** Answer GET with 405, as a server with no stream of its own does. */
  noStream?: boolean;
  /** Keep `notifications/initialized` unanswered until `answerInitialized()`. */
  holdInitialized?: boolean;
}

export interface Recorded {
  method: string;
  headers: Record<string, string>;
  /** The JSON-RPC method a POST carried, or `answer` for a reply to the server. */
  rpc?: string;
  /** What a POST carried. */
  body?: unknown;
}

export function httpServer(script: HttpScript) {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let eventId = 0;
  const push = (message: object): void => {
    for (const stream of streams) {
      try {
        stream.enqueue(encoder.encode(`id: ${(eventId += 1)}\ndata: ${JSON.stringify(message)}\n\n`));
      } catch {
        streams.delete(stream);
      }
    }
  };
  const core = scriptedServer(script, push);
  const requests: Recorded[] = [];
  let session: string | undefined;
  let sessions = 0;
  let answerInitialized: () => void = () => {};
  const initializedAnswered = new Promise<void>((resolve) => (answerInitialized = resolve));

  const server = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const headers = Object.fromEntries(req.headers.entries());
      const recorded: Recorded = { method: req.method, headers };
      requests.push(recorded);
      const sent = headers["mcp-session-id"];

      if (req.method === "POST") {
        const message = (await req.json()) as { id?: string | number; method?: string };
        recorded.rpc = message.method ?? "answer";
        recorded.body = message;
        const initializing = message.method === "initialize";
        if (script.sessions && !initializing) {
          if (!sent) return new Response("a session is required", { status: 400 });
          if (sent !== session) return new Response("no such session", { status: 404 });
        }
        const answer = core.handle(message);
        if (script.holdInitialized && message.method === "notifications/initialized") await initializedAnswered;
        if (!answer) return new Response(null, { status: 202 });
        if (initializing && script.sessions) session = `session-${(sessions += 1)}`;
        return Response.json(answer, initializing && session ? { headers: { "mcp-session-id": session } } : {});
      }

      if (req.method === "GET") {
        if (script.noStream) return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
        if (script.sessions && sent !== session) return new Response("no such session", { status: 404 });
        let opened: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => void streams.add((opened = controller)),
          cancel: () => void streams.delete(opened!),
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }

      if (req.method === "DELETE") return new Response(null, { status: 200 });
      return new Response(null, { status: 405 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    core,
    requests,
    /** POSTs carrying `rpc`, in order. */
    posts: (rpc?: string) => requests.filter((r) => r.method === "POST" && (rpc === undefined || r.rpc === rpc)),
    gets: () => requests.filter((r) => r.method === "GET"),
    /** GET streams open right now. */
    open: () => streams.size,
    push,
    /** End every open GET stream from the server's side, as a server may whenever it likes. */
    endStreams: () => {
      for (const stream of streams) {
        try {
          stream.close();
        } catch {
          // Already gone from the client's side.
        }
      }
      streams.clear();
    },
    /** Forget the session, as a server that restarted has: everything carrying it is answered 404. */
    dropSession: () => void (session = undefined),
    /** Answer the `notifications/initialized` held by `holdInitialized`. */
    answerInitialized: () => answerInitialized(),
    stop: () => server.stop(true),
  };
}
