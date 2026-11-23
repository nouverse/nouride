/**
 * A CONNECT proxy and servers on 127.0.0.1, for the tests that prove a socket went through the proxy: the proxy keeps
 * every CONNECT target it was asked for, and tunnels it.
 */

import type { ServerWebSocket as BunServerWebSocket } from "bun";
import { connect, createServer, type Socket } from "node:net";

type ServerWebSocket = BunServerWebSocket<undefined>;

export interface ConnectProxy {
  url: string;
  /** Every `host:port` a CONNECT asked for, in order. */
  targets: string[];
  close(): void;
}

export async function startConnectProxy(): Promise<ConnectProxy> {
  const targets: string[] = [];
  const open = new Set<Socket>();
  const server = createServer((client) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    client.on("error", () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onData);
      const [method, target = ""] = head.subarray(0, end).toString("latin1").split("\r\n")[0]!.split(" ");
      if (method !== "CONNECT") return void client.end("HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n\r\n");
      targets.push(target);
      const at = target.lastIndexOf(":");
      const upstream = connect(Number(target.slice(at + 1)), target.slice(0, at), () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      open.add(upstream);
      upstream.on("close", () => open.delete(upstream));
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    targets,
    close: () => {
      for (const socket of open) socket.destroy();
      server.close();
    },
  };
}

/** A websocket server on 127.0.0.1, for a test outside this package that may not call Bun itself. */
export function serveWebSocket(on: { open: (ws: ServerWebSocket) => void; message?: (ws: ServerWebSocket, data: string | Buffer) => void }) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
      if (srv.upgrade(req, protocol ? { headers: { "sec-websocket-protocol": protocol } } : undefined)) return;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: { open: on.open, message: on.message ?? (() => {}) },
  });
  return { url: `ws://127.0.0.1:${server.port}/`, port: server.port as number, stop: (force?: boolean) => server.stop(force) };
}

/** A websocket server that says "hello" to whoever opens a socket, and answers the first protocol asked for. */
export function startHelloServer() {
  return serveWebSocket({ open: (ws) => ws.send("hello") });
}

/** An HTTP server on `hostname`, answering with `answer`. */
export function serveHttp(hostname: string, answer: (req: Request) => Response) {
  const server = Bun.serve({ port: 0, hostname, fetch: answer });
  return { port: server.port as number, stop: (force?: boolean) => server.stop(force) };
}
