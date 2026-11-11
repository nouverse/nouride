import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, Lock, LogIn, ShieldCheck, User } from "lucide-react";
import { api } from "@/commons/lib/api";
import { nextOf } from "@/commons/lib/session";
import { Mascot } from "@/commons/components/brand/Mascot";
import { Details } from "@/commons/components/ui/Details";
import { PasswordInput } from "@/commons/components/ui/PasswordInput";

/**
 * What the OAuth callback can send a visitor back with.
 *
 * The daemon redirects rather than rendering, so these arrive as `?error=` on a full page load. Each
 * one is a different person's problem, which is why they are not one message: `no_account` is the
 * operator's, `misconfigured` is the operator's too but for a different reason, and the other two are
 * worth a second attempt. An unrecognised value falls through to a generic line rather than nothing —
 * a blank login form after a failed round trip looks like the click did not register.
 */
function externalError(code: string | null, label: string): string | null {
  switch (code) {
    case "provider_unreachable":
      return `Could not reach ${label}. Try again, or sign in with a username and password.`;
    case "misconfigured":
      return `Signing in with ${label} is not fully set up yet. Whoever set it up needs to finish it.`;
    case "oauth_failed":
      return `${label} sign-in did not complete. Try again.`;
    case "no_account":
      return `That ${label} account has no access here. Accounts are made by whoever runs this server; ask them to add yours.`;
    case null:
      return null;
    default:
      return "External sign-in did not complete.";
  }
}

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The same query `useGate` runs, so this reads from cache rather than making a second request.
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupState, staleTime: 2_000 });
  const external = setup.data?.oauth;
  // Absent reads as true: a daemon older than the setting says nothing, and a
  // page with neither a form nor a button cannot be answered.
  const passwordLogin = setup.data?.passwordLogin !== false;
  // Read once, from the location rather than the router: the callback arrives as a browser
  // navigation, and holding it in state means a failed password attempt afterwards does not
  // redraw a stale banner about the previous OAuth round trip.
  const [externalCode] = useState(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("error"),
  );
  const externalMessage = externalError(externalCode, external?.label ?? "the provider");
  // The page a link opened before this form took its place (0.8.11): where a sign-in goes on to, either way in.
  const [next] = useState(() => (typeof window === "undefined" ? null : nextOf(window.location.search)));

  const signIn = useMutation({
    mutationFn: () => api.login(username, password),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      void navigate({ href: next ?? "/" });
    },
  });

  return (
    <div className="relative flex min-h-dvh items-center justify-center p-4 selection:bg-primary/20 overflow-clip">

      <div className="relative w-full max-w-sm rounded-[22px] border border-base-content/[0.08] bg-base-100 p-7 sm:p-8 shadow-soft transition-all duration-200">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            signIn.mutate();
          }}
        >
          {/* Brand & Icon */}
          <div className="space-y-3">
            <Mascot pose="waving" decorative className="-mt-2 -mb-1 w-24" />
            <div className="space-y-0.5">
              <h1 className="text-2xl text-base-content">Sign in to Nouride</h1>
              <p className="text-base-content/65 text-sm">Your agents, their chats and their work, in one place.</p>
            </div>
          </div>

          {passwordLogin && (
          <div className="space-y-3.5">
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono">
                Username
              </span>
              <div className="relative">
                <input
                  className="input w-full pl-9 rounded-xl text-sm focus:ring-2 focus:ring-primary/20"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  placeholder="username"
                  required
                />
                <User size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/40 pointer-events-none" />
              </div>
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-base-content/70 font-mono">
                Password
              </span>
              <div className="relative">
                <PasswordInput
                  className="input w-full pl-9 rounded-xl text-sm focus:ring-2 focus:ring-primary/20"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  required
                />
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-base-content/40 pointer-events-none" />
              </div>
            </label>
          </div>
          )}

          {externalMessage && !signIn.isError && (
            <div className="alert bg-warning/10 border border-warning/30 text-warning text-xs rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>{externalMessage}</span>
            </div>
          )}

          {!passwordLogin && !external?.available && (
            <div className="alert alert-error bg-error/10 border border-error/30 text-error text-xs rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p>
                  There is no way to sign in yet: signing in with a password is off, and no other way is set up.
                  Whoever runs this server needs to fix it.
                </p>
                <Details>
                  <p>Set `[dashboard]` in `config.toml`.</p>
                </Details>
              </div>
            </div>
          )}

          {signIn.isError && (
            <div className="alert alert-error bg-error/10 border border-error/30 text-error text-xs rounded-xl p-3 flex items-center gap-2">
              <AlertTriangle size={15} className="shrink-0" />
              <span>{(signIn.error as Error).message}</span>
            </div>
          )}

          {passwordLogin && (
          <button
            type="submit"
            className="btn btn-primary w-full rounded-xl gap-2 shadow-md shadow-primary/20 active:scale-95 transition-all text-sm font-semibold"
            disabled={signIn.isPending}
          >
            {signIn.isPending ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <LogIn size={15} />
            )}
            Sign In
          </button>
          )}

          {external?.available && (
            <>
              {/* The divider only divides something. With the password form off
                  there is one way in, and "OR" above a single button reads as a
                  missing option. */}
              {passwordLogin && (
                <div className="flex items-center gap-3">
                  <span className="h-px flex-1 bg-base-content/[0.08]" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-base-content/65 font-mono">or</span>
                  <span className="h-px flex-1 bg-base-content/[0.08]" />
                </div>
              )}

              {/*
                A link, not a button in a form: the flow is a browser navigation the whole way — the
                daemon sets a cookie and 302s to the provider, so anything that fetched this would
                have to follow a redirect to a third party and could not.
              */}
              <a
                href={`/api/control/auth/oauth/start${next ? `?next=${encodeURIComponent(next)}` : ""}`}
                className="btn btn-outline w-full rounded-xl gap-2 active:scale-95 transition-all text-sm font-semibold"
              >
                <ShieldCheck size={15} />
                Continue with {external.label}
              </a>
            </>
          )}

          <div className="pt-2 text-center border-t border-base-content/[0.06]">
            <a
              href="https://nouverse.tech"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-base-content/65 hover:text-primary transition-colors duration-150"
            >
              <span>Powered by</span>
              <span className="font-semibold text-base-content/65 hover:text-primary">Nouverse Technologies</span>
            </a>
          </div>
        </form>
      </div>
    </div>
  );
}
