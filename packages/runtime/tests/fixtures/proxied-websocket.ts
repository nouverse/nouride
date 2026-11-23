/**
 * `proxyWebSockets`, then a socket made with the global class, as a library that keeps it would make one: run as its own
 * process by `proxy.test.ts`, since the global is the process's. Prints what the server said, the protocol it took, and
 * whether the class was wrapped once.
 */

import { proxyWebSockets } from "../../src/index.ts";

const Native = globalThis.WebSocket;
proxyWebSockets();
// A second call must not wrap the class again: the daemon makes its gateways more than once.
proxyWebSockets();
const wrappedOnce = Object.getPrototypeOf(globalThis.WebSocket) === Native;
const socket = new WebSocket(process.argv[2]!, ["chat"]);
const said = await new Promise<string>((resolve, reject) => {
  socket.onmessage = (event) => resolve(String(event.data));
  socket.onerror = () => reject(new Error("the socket failed"));
});
console.log(JSON.stringify({ said, protocol: socket.protocol, wrappedOnce }));
socket.close();
process.exit(0);
