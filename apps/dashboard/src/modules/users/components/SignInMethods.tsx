/**
 * How people sign in to this daemon — one switch for the whole install.
 *
 * It sits on Users because that is the page an admin is on when they think
 * about who may get in, and the question it answers is the one they actually
 * have: "can somebody still sign in with a password?"
 *
 * ## Why it is not always shown
 *
 * With no identity provider configured, a password is the only way in, and a
 * switch whose only position is the one it is already in is furniture. It
 * appears when external sign-in is available and not before.
 *
 * ## Why turning it off is the careful direction
 *
 * It applies to the **next request**, including the caller's. An admin who
 * turns this off on an install whose provider is misconfigured has locked
 * themselves out of a daemon that is still running perfectly — which is worse
 * than the boot-time version of the same mistake, where the daemon refuses to
 * start and says why over SSH.
 *
 * So the daemon refuses it unless the provider has a client secret that
 * actually resolves, and this asks for confirmation before sending it. The
 * confirmation is not politeness: it is the only moment the consequence can be
 * stated to the person about to cause it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, KeyRound, ShieldCheck } from "lucide-react";
import { api } from "@/commons/lib/api";
import { isAdmin, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

export function SignInMethods() {
  const me = useMe();
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupState, staleTime: 2_000 });
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const saved = useSaved();
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.setPasswordLogin(enabled),
    onSuccess: (answer, enabled) => {
      saved(answer, `Password sign-in ${enabled ? "on" : "off"}`);
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["setup"] });
    },
  });

  const external = setup.data?.oauth;
  // Absent reads as on — a daemon older than the setting says nothing, and the
  // switch must not claim a state the daemon is not in.
  const passwordLogin = setup.data?.passwordLogin !== false;

  // Nothing to choose between: with no provider, a password is the only way in.
  if (!external?.available) return null;
  if (!isAdmin(me.data ?? null)) return null;

  return (
    <div className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-5 shadow-soft space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-bold tracking-tight text-base-content">
            {passwordLogin ? (
              <KeyRound size={15} className="text-info" />
            ) : (
              <ShieldCheck size={15} className="text-success" />
            )}
            Password sign-in
            <span className="badge badge-xs badge-ghost font-semibold font-mono">everyone</span>
          </p>
          <p className="mt-1 max-w-prose text-xs text-base-content/65 sm:text-sm">
            {passwordLogin ? (
              <>
                The login page shows a username and password field alongside{" "}
                <span className="font-semibold">Continue with {external.label}</span>. Turn this off
                and {external.label} becomes the only way in.
              </>
            ) : (
              <>
                Off. The login page shows only{" "}
                <span className="font-semibold">Continue with {external.label}</span>, no username
                or password field. Existing passwords are kept and work again if you turn this back
                on.
              </>
            )}
          </p>
        </div>

        <input
          type="checkbox"
          className="toggle toggle-primary shrink-0"
          checked={passwordLogin}
          disabled={save.isPending}
          onChange={(e) => {
            // Turning it ON is never dangerous, so it goes straight through.
            // Turning it OFF asks, because it lands on the asker's own session.
            if (e.target.checked) save.mutate(true);
            else setConfirming(true);
          }}
        />
      </div>

      {confirming && (
        <div className="space-y-3 rounded-xl border border-warning/30 bg-warning/10 p-3">
          <p className="flex items-start gap-2 text-xs text-warning">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              After this, the only way into this instance is {external.label}. That includes you, on
              your next sign-in, so make sure your own account&apos;s username is the email on your{" "}
              {external.label} account, or you will be turned away at your own dashboard.
            </span>
          </p>
          <div className="flex gap-2">
            <button
              className="btn btn-warning btn-sm rounded-xl"
              disabled={save.isPending}
              onClick={() => save.mutate(false)}
            >
              {save.isPending ? "Turning off…" : `Yes, ${external.label} only`}
            </button>
            <button
              className="btn btn-ghost btn-sm rounded-xl"
              disabled={save.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {save.isError && <ErrorNote error={save.error as Error} />}
    </div>
  );
}
