/**
 * What a save from the CLI says it did: applied, or saved and waiting for a restart.
 *
 * Each command that writes a setting used to word this its own way — `gateway add` warned that nothing was connected
 * yet, `mcp add` said it was connecting, `access mode` said "no restart", and the rest said nothing — so a person, or
 * an agent reading the output, could not tell from the line whether the change was in force. The daemon's answer
 * decides it: `restartRequired`, from the setter that wrote the key (`config/settings/*.ts`). A route that answers
 * without it changed nothing the daemon reads at boot, so the save applied.
 */

import { DIM, GREEN, RESET, YELLOW, emit, say } from "@nouride/cli-kit";

interface SaveAnswer {
  restartRequired?: boolean;
}

/** `✓ <what>: applied`, or `saved (takes effect after a restart)` and how to restart; under `--json`, the same as data. */
export function saidSaved(what: string, answer: SaveAnswer | null | undefined, restart = "nouride restart"): void {
  const waits = answer?.restartRequired === true;
  emit({ ...(answer ?? {}), restartRequired: waits, applied: !waits });
  if (!waits) return say(`${GREEN}✓${RESET} ${what}: applied`);
  say(`${GREEN}✓${RESET} ${what}: saved ${YELLOW}(takes effect after a restart)${RESET}`);
  say(`${DIM}  ${restart}${RESET}`);
}
