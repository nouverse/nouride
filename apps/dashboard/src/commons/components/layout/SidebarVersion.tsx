/**
 * The line under the wordmark: which version this is, and a dot when something newer exists.
 *
 * It replaced "your agent runtime", which was a tagline — true, and the same on every install
 * on every day. The version is the fact somebody in a dashboard actually wants from that
 * corner: two boxes running the same product differ by this, and it was previously readable
 * only by scrolling the Overview header.
 *
 * ## Why the dot does not link to the update page
 *
 * It is inside the brand link, which goes to Home, and that is deliberate: the brand is the
 * way home and nesting a second destination inside it makes a click a coin toss. The dot says
 * *that* there is something; the badge on Home or the button on Your box is what you press. One signal in two places,
 * with only one of them a door.
 */

import { badgeState, editionLabel, useUpdate } from "@/commons/hooks/use-update";

export function SidebarVersion() {
  const status = useUpdate();
  const state = badgeState(status.data);
  /**
   * `install?.version`, not `install.version`.
   *
   * Optional chaining stops at `data`; a response that arrived without an `install` — an error
   * body, an older daemon, a stubbed fetch — then threw inside the sidebar and took the whole
   * page down with it. Caught by the mount tests, which render every page against a generic
   * stub, and it is the right shape anyway: this line has a fallback for not knowing.
   */
  const version = status.data?.install?.version;
  const edition = status.data?.install?.edition;

  if (!version) {
    return <p className="text-base-content/65 text-[11px] font-medium tracking-wide">your agents, at home</p>;
  }

  const pending = state === "available" || state === "downloading" || state === "ready";

  return (
    <p className="text-base-content/65 flex items-center gap-1.5 text-[11px] font-medium tracking-wide">
      <span className="tabular-nums">
        v{version}
        {/* Which build, in the word a person uses for it — two boxes on this version can differ. */}
        {edition && edition !== "unknown" ? ` (${editionLabel(edition)})` : ""}
      </span>
      {pending && (
        <span
          className="inline-flex items-center gap-1 text-info"
          title={`${status.data?.check?.latest ?? "A newer version"} is available`}
        >
          <span className="size-1.5 rounded-full bg-info" />
          update
        </span>
      )}
    </p>
  );
}
