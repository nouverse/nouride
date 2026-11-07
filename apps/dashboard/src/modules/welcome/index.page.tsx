/**
 * First-login account setup — always username + password together, one form, one submission.
 * Remade with Apple HIG: frosted glass card, ambient glow, clean typography,
 * and tactile action button.
 */

import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { api } from "@/commons/lib/api";
import { useGate } from "@/commons/lib/session";
import { ErrorNote, Field } from "@/commons/components/ui/ui";
import { NovaAppIcon } from "@/commons/components/icons/logos";
import { MIN_PASSWORD_LENGTH } from "@/commons/lib/password";

export default function WelcomePage() {
  const gate = useGate("/welcome");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const current = gate.principal?.user?.username ?? "";
  const [username, setUsername] = useState(current);
  // The principal can arrive after the first render; show the name they are signed in with, which
  // they may keep — `admin` included, as Nougate allows.
  const [filled, setFilled] = useState(Boolean(current));
  useEffect(() => {
    if (!filled && current) {
      setUsername(current);
      setFilled(true);
    }
  }, [current, filled]);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  /**
   * The admin's own name, on the first login: the account becomes that person in `[[people]]`, so
   * the agents know who they are talking to here and on every other platform linked to them. Only an
   * admin: the daemon refuses anyone else.
   */
  const admin = gate.principal?.user?.role === "admin";
  const [name, setName] = useState(gate.principal?.user?.displayName ?? "");

  const save = useMutation({
    mutationFn: async () => {
      const trimmed = username.trim().toLowerCase();
      if (!trimmed) throw new Error("Username is required.");
      // Only when it changed: renaming revokes other sessions, and keeping `admin` is allowed.
      if (trimmed !== current.toLowerCase()) await api.saveProfile({ username: trimmed });
      await api.changePassword("", next);
      if (admin && name.trim()) {
        await api.saveProfile({ displayName: name.trim() });
        const self = await api.peopleMe();
        if (!self.person) await api.linkMe({ name: name.trim() });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      void navigate({ to: "/" });
    },
  });

  const short = next.length > 0 && next.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = username.trim().length > 0 && next.length >= MIN_PASSWORD_LENGTH && next === confirm;

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4 selection:bg-primary/20 overflow-clip">
      {/* Ambient Apple Glow */}
      <div className="absolute top-1/4 -left-32 size-96 rounded-full bg-primary/15 blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 -right-32 size-96 rounded-full bg-secondary/15 blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-md rounded-3xl border border-base-content/[0.08] bg-base-100/85 backdrop-blur-2xl p-7 sm:p-8 shadow-2xl space-y-6">
        <div className="space-y-3 text-center sm:text-left">
          <NovaAppIcon className="size-12 drop-shadow-lg mx-auto sm:mx-0" />
          <div className="space-y-1">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-base-content">
              Personalize Your Account
            </h1>
            <p className="text-base-content/65 text-sm leading-relaxed">
              Choose the username and password you will sign in with from now on.
            </p>
          </div>
        </div>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate();
          }}
        >
          <Field label="Username" hint="Letters, digits, dot, dash, underscore.">
            <input
              className="input w-full rounded-xl text-sm"
              type="text"
              autoComplete="username"
              autoFocus
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </Field>

          {admin ? (
            <Field label="Your name" hint="What your agents call you.">
              <input
                className="input w-full rounded-xl text-sm"
                type="text"
                autoComplete="name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          ) : null}

          <Field label="New Password" hint={`Minimum ${MIN_PASSWORD_LENGTH} characters.`}>
            <input
              className={`input w-full rounded-xl text-sm ${short ? "input-error" : ""}`}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </Field>

          <Field label="Confirm New Password">
            <input
              className={`input w-full rounded-xl text-sm ${mismatch ? "input-error" : ""}`}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </Field>

          {mismatch && <p className="text-error text-xs font-semibold">Passwords do not match.</p>}
          <ErrorNote error={save.error} />

          <button
            type="submit"
            className="btn btn-primary w-full rounded-xl gap-2 shadow-md shadow-primary/25 font-semibold active:scale-95 transition-all text-sm mt-2"
            disabled={!ready || save.isPending}
          >
            {save.isPending ? (
              <span className="loading loading-spinner loading-sm" />
            ) : (
              <KeyRound size={16} />
            )}
            Save Account & Continue
          </button>

          <p className="text-base-content/65 text-center text-[11px] leading-relaxed">
            Signed in as {gate.principal?.actor}. Saving this signs you out everywhere else.
          </p>
        </form>
      </div>
    </div>
  );
}
