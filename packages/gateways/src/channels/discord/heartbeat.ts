/**
 * Discord's first heartbeat comes about 41 s after its Hello (`heartbeat_interval`, 41,250 ms in Discord's gateway
 * docs), and the first health check runs 30 s after connecting: with no heartbeat back yet, every boot logged a
 * "health check failed" for each bot (live box, 0.8.6 and before). A client this young has nothing to be judged by.
 */
const FIRST_HEARTBEAT_MS = 41_250 + 15_000;

/**
 * Whether the connection is alive by its heartbeat: one answered (`ping` ≥ 0), or none due yet. Past the first
 * heartbeat's time with none answered, it is not — `-1` then means the heartbeats go unanswered.
 */
export function heartbeatAlive(ping: number, readyAt: number | null, now: number): boolean {
  if (ping >= 0) return true;
  return readyAt !== null && now - readyAt < FIRST_HEARTBEAT_MS;
}
