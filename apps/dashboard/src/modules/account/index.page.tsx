/**
 * Your own account settings.
 * Remade with Apple HIG: clean profile cards, password strength validation,
 * and tactile submit buttons.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, KeyRound, LogOut } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, ErrorNote, Field, PageHeader } from "@/commons/components/ui/ui";
import { PersonCard } from "./person.card";
import { useSignOut } from "@/commons/components/layout/sign-out";
import { useMe } from "@/commons/lib/session";
import { MIN_PASSWORD_LENGTH } from "@/commons/lib/password";
import { PasswordInput } from "@/commons/components/ui/PasswordInput";

export default function AccountPage() {
  const me = useMe();

  const user = me.data?.user ?? null;

  const { signOut, dialog: signOutDialog } = useSignOut();

  return (
    <div className="space-y-6">
      {signOutDialog}
      <PageHeader
        title="My Account"
        description="Manage your login credentials, personal display name, and session authentication."
        actions={
          <button
            type="button"
            className="btn btn-ghost btn-sm rounded-xl gap-2 font-medium text-error hover:bg-error/10 active:scale-95 transition-all"
            onClick={signOut}
          >
            <LogOut size={15} /> Sign Out
          </button>
        }
      />

      {!user ? (
        <Card title="Signed In by the Server">
          <p className="text-base-content/65 text-sm leading-relaxed">
            You are signed in with the server's own key, not a personal account. Sign in with your own account to change your name and password.
          </p>
        </Card>
      ) : (
        <div className="grid gap-6">
          <ProfileCard
            username={user.username}
            displayName={user.displayName}
            role={user.role}
            lastLoginAt={user.lastLoginAt}
          />
          <PersonCard admin={user.role === "admin"} displayName={user.displayName ?? user.username} />
          <PasswordCard />
        </div>
      )}
    </div>
  );
}

function ProfileCard({
  username,
  displayName,
  role,
  lastLoginAt,
}: {
  username: string;
  displayName: string;
  role: string;
  lastLoginAt: number | null;
}) {
  const queryClient = useQueryClient();
  const [nextUsername, setNextUsername] = useState(username);
  const [name, setName] = useState(displayName);

  const save = useMutation({
    mutationFn: () => api.saveProfile({ username: nextUsername, displayName: name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  const dirty = nextUsername !== username || name !== displayName;

  return (
    <Card
      title="User Profile"
      description={`Role: ${role} · ${lastLoginAt ? `Last active ${new Date(lastLoginAt).toLocaleString()}` : "Initial session"}`}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate();
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Username"
            hint="Used for dashboard sign-in. Changing username revokes other active sessions."
          >
            <input
              className="input w-full rounded-xl text-sm"
              value={nextUsername}
              autoComplete="username"
              onChange={(e) => setNextUsername(e.target.value)}
              required
            />
          </Field>

          <Field
            label="Display Name (optional)"
            hint="How you prefer agents to address you."
          >
            <input
              className="input w-full text-sm rounded-xl"
              value={name}
              placeholder="Your name"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>

        <ErrorNote error={save.error} />

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            Save Profile
          </button>
          {save.isSuccess && !dirty && (
            <span className="text-success flex items-center gap-1 text-xs font-semibold">
              <Check size={14} /> Profile updated
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const queryClient = useQueryClient();

  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: async () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && next === confirm;

  return (
    <Card
      title="Update Password"
      description="Updating your password signs out all other concurrent sessions for this account."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) change.mutate();
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Current Password">
            <PasswordInput
              className="input w-full rounded-xl text-sm"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </Field>
          <Field label="New Password" hint={`Minimum ${MIN_PASSWORD_LENGTH} characters.`}>
            <PasswordInput
              className="input w-full rounded-xl text-sm"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </Field>
          <Field label="Confirm New Password">
            <PasswordInput
              className={`input w-full rounded-xl text-sm ${mismatch ? "input-error" : ""}`}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </Field>
        </div>

        {mismatch && <p className="text-error text-xs font-semibold">Passwords do not match.</p>}
        <ErrorNote error={change.error} />

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
            disabled={!ready || change.isPending}
          >
            {change.isPending ? <span className="loading loading-spinner loading-xs" /> : <KeyRound size={14} />}
            Change Password
          </button>
          {change.isSuccess && (
            <span className="text-success flex items-center gap-1 text-xs font-semibold">
              <Check size={14} /> Password successfully changed
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
