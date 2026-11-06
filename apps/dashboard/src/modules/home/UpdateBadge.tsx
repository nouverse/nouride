/**
 * The one-glance answer to "is this current?", and the only way into the update page.
 *
 * Deliberately not a sidebar entry. Updating is something you do rarely and only when there is
 * something to do, and a permanent menu item for it competes for attention with the things
 * somebody opens the dashboard to use. The badge earns its place by changing: it is quiet when
 * there is nothing to say and it is a link when there is.
 *
 * It is never hidden entirely, though. "Up to date" is information too — a badge that only
 * appeared when something was wrong would leave "is it checking at all?" unanswerable.
 *
 * ## It never says the version is unknown
 *
 * It said that once, sitting two inches from `v0.3.1` in the same header, because the check had
 * failed. The version is never unknown; what can be unknown is whether anything newer exists,
 * and the reason for that is the thing worth saying. A failed check is also the case where
 * somebody most wants to click through, so it is a link rather than dead text.
 */

import { Link } from "@tanstack/react-router";
import { ArrowUpCircle, CheckCircle2, CircleDashed, CloudOff, Download, MinusCircle } from "lucide-react";
import { badgeState, useUpdate } from "@/commons/hooks/use-update";

const SHELL =
  "flex items-center gap-2 px-3 py-1.5 rounded-full border shadow-xs text-xs font-semibold transition-colors";

const QUIET = "bg-base-100 border-base-content/10 text-base-content/65";

export function UpdateBadge() {
  const status = useUpdate();
  const state = badgeState(status.data);

  if (state === "checking") {
    return (
      <span className={`${SHELL} ${QUIET}`}>
        <CircleDashed size={13} className="animate-spin" />
        Checking for updates…
      </span>
    );
  }

  if (state === "unsupported") {
    // Nothing will ever change here, so it is not a link: the page would only repeat this.
    return (
      <span className={`${SHELL} ${QUIET}`} title="This version of Nouride cannot check for updates by itself">
        <MinusCircle size={13} />
        Updates unavailable
      </span>
    );
  }

  if (state === "unreachable") {
    return (
      <Link
        to="/update"
        className={`${SHELL} bg-warning/10 border-warning/40 text-warning hover:bg-warning/15`}
        title="Nouride could not check for updates. Open Update to see why"
      >
        <CloudOff size={13} />
        Update check failed
      </Link>
    );
  }

  if (state === "current") {
    return (
      <Link to="/update" className={`${SHELL} ${QUIET} hover:border-base-content/25`}>
        <CheckCircle2 size={13} className="text-success" />
        Up to date
      </Link>
    );
  }

  const label =
    state === "ready"
      ? `${status.data?.check?.latest ?? "Update"} ready to install`
      : state === "downloading"
        ? `Downloading ${status.data?.check?.latest ?? "update"}`
        : `${status.data?.check?.latest ?? "Update"} available`;

  return (
    <Link to="/update" className={`${SHELL} bg-info/10 border-info/40 text-info hover:bg-info/15`}>
      {state === "downloading" ? <Download size={13} /> : <ArrowUpCircle size={13} />}
      {label}
    </Link>
  );
}
