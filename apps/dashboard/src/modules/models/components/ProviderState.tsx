/**
 * Where a provider profile stands, on the Models page: its key, or, on the Nougate this server carries, where Nougate
 * stands; and the way to Nougate's own page, which is opened from here rather than from the menu.
 */

import { Link } from "@tanstack/react-router";
import type { ProviderProfileView } from "@nouride/wire";
import { NougateMark } from "@/commons/components/brand/logos";

/** The way to Nougate's own page, where the accounts its two providers answer with are signed in. */
export function OpenNougate() {
  return (
    <Link to="/llm-gateway" className="btn btn-ghost btn-sm rounded-xl gap-2 font-semibold">
      <NougateMark className="size-4 shrink-0" />
      Open Nougate
    </Link>
  );
}

/**
 * Whether a profile can answer: its key, or, on the Nougate this server carries, where Nougate stands. Off, and on with
 * no account signed in, are said as that rather than as a missing key: Nougate gives its providers their key itself.
 */
export function ProfileBadge({ profile }: { profile: ProviderProfileView }) {
  const [tone, words, why] =
    profile.bundled === "off"
      ? ["badge-ghost", "Off", "Nougate is off. Turn it on from its page, then sign in an account there."]
      : profile.bundled === "no-account"
        ? ["badge-warning", "No account", "Nougate is on, with no account signed in yet. Sign one in on its page."]
        : profile.hasCredential
          ? ["badge-success", "Key Active", undefined]
          : ["badge-error", "No Key Set", undefined];
  return (
    <span className={`badge badge-sm shrink-0 whitespace-nowrap font-semibold shadow-xs ${tone}`} title={why}>
      {words}
    </span>
  );
}
