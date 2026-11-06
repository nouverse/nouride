/**
 * A run's result line, with the mission it started a link to that mission's page (0.8.0): "started mission msn_…" and
 * "the last run, mission msn_…, is still working" say which, and how the run went is on that page — the Schedule and
 * Webhooks pages' run lists both read it this way.
 */

import { Link } from "@tanstack/react-router";

/** A mission id inside a run's result: `msn_` and the hex `newId` mints. */
const MISSION_ID = /\bmsn_[0-9a-f]+\b/;

export function RunResult({ text }: { text: string }) {
  const found = MISSION_ID.exec(text);
  if (!found) return <>{text}</>;
  const at = found.index;
  return (
    <>
      {text.slice(0, at)}
      <Link className="link" to="/missions/$missionId" params={{ missionId: found[0] }}>
        {found[0]}
      </Link>
      {text.slice(at + found[0].length)}
    </>
  );
}
