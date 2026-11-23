/**
 * A Discord connection made the daemon's way — `createGateways` first, then discord.js — logging in against a REST API
 * and a gateway of the test's own: run as its own process by `discord-proxy.test.ts`, since what it proves is which
 * `WebSocket` discord.js keeps when it is first imported. Prints how the login ended, as JSON.
 */

import { createGateways } from "../../src/index.ts";

const api = process.argv[2]!;
await createGateways(
  [{ id: "discord:proxy", platform: "discord", name: "proxy", enabled: true, tokenSecret: "DISCORD_PROXY_TEST" }],
  () => "stand-in.token.value",
);
const { Client } = await import("discord.js");
const client = new Client({ intents: [], rest: { api } });
const ended = await client.login("stand-in.token.value").then(
  () => "logged in",
  (err: unknown) => String(err),
);
await client.destroy();
console.log(JSON.stringify({ ended }));
process.exit(0);
