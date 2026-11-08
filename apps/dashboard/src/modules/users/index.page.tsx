/**
 * Dashboard accounts management.
 * Remade with Apple HIG: clean table layout, role capsules,
 * modal creation form, and role definitions card.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ExternalLink, Info, Plus, ShieldCheck, Trash2, Users as UsersIcon } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, EmptyState, ErrorNote, Field, PageHeader } from "@/commons/components/ui/ui";
import { FILL_PAGE, ScrollCard } from "@/commons/components/ui/ScrollCard";
import { useConfirm } from "@/commons/components/ui/confirm";
import { PersonPicker } from "@/commons/components/people/PersonPicker";
import type { PersonRecord } from "@/commons/lib/api.people";
import { SignInMethods } from "./components/SignInMethods";
import { useMe } from "@/commons/lib/session";
import { PasswordInput } from "@/commons/components/ui/PasswordInput";
import { ListLoading } from "@/commons/components/ui/Spinner";

/** The person an account is linked to: `web:<id>`. */
function personOfAccount(people: PersonRecord[], userId: string): PersonRecord | undefined {
  return people.find((person) => (person.ids ?? []).includes(`web:${userId}`));
}

const ROLES = [
  { id: "admin", label: "Admin", blurb: "Can do everything, including accounts, AI providers and Nouride's own settings." },
  { id: "operator", label: "Operator", blurb: "Runs the day to day: agents, their files, and approvals. Cannot change accounts." },
  { id: "viewer", label: "Viewer", blurb: "Can look at everything, the agents and their settings included, and change nothing." },
];

export default function UsersPage() {
  const me = useMe();
  const users = useQuery({ queryKey: ["users"], queryFn: api.users });
  const people = useQuery({ queryKey: ["people"], queryFn: api.people });
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const link = useMutation({
    mutationFn: ({ user, target }: { user: string; target: Parameters<typeof api.linkUser>[1] }) => api.linkUser(user, target),
    onSuccess: async () => {
      setLinking(null);
      await queryClient.invalidateQueries({ queryKey: ["people"] });
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["users"] });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteUser(id), onSuccess: invalidate });
  const setRole = useMutation({
    mutationFn: (input: { id: string; role: string }) => api.setUserRole(input.id, input.role),
    onSuccess: invalidate,
  });

  const currentUser = me.data?.user?.id ?? "";
  const list = users.data?.users ?? [];
  const multiUser = Boolean(users.data?.multiUser);
  const { ask, dialog } = useConfirm();

  return (
    <div className={FILL_PAGE}>
      {dialog}
      <PageHeader
        title="User Accounts"
        description={
          multiUser
            ? "Manage authenticated dashboard users and assign granular permission roles."
            : "Manage authenticated dashboard user accounts."
        }
        actions={
          multiUser ? (
            <button
              type="button"
              className="btn btn-primary btn-sm rounded-xl gap-2 shadow-xs active:scale-95 transition-all"
              onClick={() => setAdding(true)}
            >
              <Plus size={16} /> Add User
            </button>
          ) : null
        }
      />

      {!multiUser && (
        <div className="alert alert-info bg-info/10 text-info border border-info/20 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs">
          <div className="flex items-start sm:items-center gap-3">
            <Info size={18} className="shrink-0 mt-0.5 sm:mt-0 text-info" />
            <p className="text-sm text-base-content/80 leading-relaxed">
              Multi-user accounts and role management are available only in the{" "}
              <span className="font-semibold text-base-content">Pro</span> editions.
            </p>
          </div>
          <a
            href="https://nouverse.com/agent"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost btn-xs text-primary hover:bg-primary/10 gap-1.5 font-medium shrink-0 self-end sm:self-auto"
          >
            Visit nouverse.com
            <ExternalLink size={13} />
          </a>
        </div>
      )}

      <SignInMethods />

      {multiUser && adding && (
        <NewUserForm
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void invalidate();
          }}
        />
      )}

      {/* What the roles mean, before the list that assigns them. */}
      {multiUser && (
        <Card title="Role Permissions Summary" description="Overview of access boundaries across roles.">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
            {ROLES.map((role) => (
              <div key={role.id} className="p-3.5 rounded-xl bg-base-200/40 border border-base-content/[0.06] space-y-1">
                <dt className="font-bold text-base-content">{role.label}</dt>
                <dd className="text-base-content/65 leading-relaxed text-xs">{role.blurb}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <ScrollCard fill title="Accounts">
        {users.isPending ? (
          <ListLoading />
        ) : list.length === 0 ? (
          <EmptyState icon={UsersIcon} title="No user accounts registered" />
        ) : (
          <div className="overflow-x-auto -mx-4 -my-2 sm:-mx-6">
            {/* A card per account on a phone, the table from `sm` up, as People draws its rows. */}
            <table className="table table-sm block w-full sm:table">
              <thead className="bg-base-100 sticky top-0 z-10 hidden sm:table-header-group">
                <tr className="border-b border-base-content/[0.08] text-base-content/65 text-[11px] uppercase tracking-wider font-mono">
                  <th className="pl-6">Account</th>
                  {multiUser && <th>Role</th>}
                  <th title="The person this account is linked to">Person</th>
                  <th>Last Signed In</th>
                  <th className="text-right pr-6">Actions</th>
                </tr>
              </thead>
              <tbody className="block divide-y divide-base-content/[0.06] sm:table-row-group">
                {list.map((user) => (
                  <tr key={user.id} className="block py-2 hover:bg-base-200/40 transition-colors sm:table-row sm:py-0">
                    <td className="block px-4 py-1.5 max-sm:border-0 sm:table-cell sm:py-3 sm:pl-6 sm:pr-3">
                      <div className="flex items-center gap-3">
                        <span className="bg-primary/10 text-primary border border-primary/20 grid size-8 place-items-center rounded-xl text-xs font-bold shadow-xs">
                          {(user.displayName || user.username).slice(0, 1).toUpperCase()}
                        </span>
                        <div className="leading-tight">
                          <p className="font-semibold text-sm text-base-content flex items-center gap-1.5">
                            {user.displayName || user.username}
                            {user.id === currentUser && (
                              <span className="badge badge-xs badge-primary font-semibold font-mono">you</span>
                            )}
                          </p>
                          {user.displayName && (
                            <p className="text-base-content/65 font-mono text-xs">{user.username}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    {multiUser && (
                      <td className="block px-4 py-1.5 max-sm:border-0 sm:table-cell sm:px-3 sm:py-3">
                        <select
                          className="select select-xs rounded-lg text-xs"
                          value={user.role}
                          disabled={user.id === currentUser || setRole.isPending}
                          onChange={(e) => setRole.mutate({ id: user.id, role: e.target.value })}
                        >
                          {ROLES.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    )}
                    <td className="block px-4 py-1.5 text-xs max-sm:border-0 sm:table-cell sm:px-3 sm:py-3">
                      {(() => {
                        const person = personOfAccount(people.data?.people ?? [], user.id);
                        return (
                          <div className="space-y-1">
                            <button type="button" className="btn btn-ghost btn-xs rounded-lg font-normal" onClick={() => setLinking(linking === user.id ? null : user.id)}>
                              {person ? person.name : <span className="text-base-content/65">Link…</span>}
                            </button>
                            {linking === user.id ? (
                              <PersonPicker
                                label={person ? "Change" : "Link"}
                                busy={link.isPending}
                                suggestedName={person ? "" : user.displayName || user.username}
                                onPick={(target) => link.mutate({ user: user.id, target })}
                              />
                            ) : null}
                            {linking === user.id && link.error ? <ErrorNote error={link.error} /> : null}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="block px-4 py-1.5 text-base-content/65 text-xs font-mono max-sm:border-0 sm:table-cell sm:px-3 sm:py-3">
                      <span className="font-sans sm:hidden">Last signed in </span>
                      {user.lastLoginAt
                        ? new Date(user.lastLoginAt).toLocaleString()
                        : user.mustChangePassword
                          ? "Bootstrap Credentials (Pending Change)"
                          : "Never"}
                    </td>
                    <td className="block px-4 py-1.5 max-sm:border-0 sm:table-cell sm:py-3 sm:pr-6 sm:pl-3 sm:text-right">
                      {/*
                        Absent on your own row rather than present and disabled, matching the pool
                        list: a greyed-out destructive button invites a click and then explains
                        itself, and here it looked live enough to be reported as a bug.

                        The daemon refuses it either way — `UserStore.delete` compares the caller's
                        id — so this is about not offering an action that cannot happen, not about
                        being the thing that stops it.
                      */}
                      {user.id === currentUser ? (
                        <span aria-hidden="true" className="text-xs opacity-30" title="You cannot delete your own account">
                          {"—"}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs rounded-lg text-error hover:bg-error/10"
                          disabled={remove.isPending}
                          title="Delete user"
                          aria-label={`Delete user ${user.username}`}
                          onClick={async () => {
                            const yes = await ask({
                              title: `Delete user ${user.username}?`,
                              body: "They can no longer sign in to the dashboard, and their sessions end. The person they are linked to in People stays.",
                              confirmLabel: "Delete",
                            });
                            if (yes) remove.mutate(user.id);
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ErrorNote error={remove.error ?? setRole.error} />
      </ScrollCard>

    </div>
  );
}

function NewUserForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("operator");

  // The same query the gate and the login page run, so this costs no request.
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupState, staleTime: 2_000 });
  const external = setup.data?.oauth;
  const passwordLogin = setup.data?.passwordLogin !== false;

  /**
   * With a provider configured, an account needs no password.
   *
   * The identity is matched to an existing account by email and never creates
   * one — so adding somebody IS the act that grants them access, and inventing
   * a password they will never type is a secret somebody has to deliver and
   * store for nothing.
   *
   * Defaults to off when a provider exists: that is the common case on a
   * managed instance. Forced off, with no choice offered, when password sign-in
   * is disabled entirely — a password there could not be used by anyone.
   */
  const [withPassword, setWithPassword] = useState(false);
  const usePassword = passwordLogin && (withPassword || !external?.available);

  const create = useMutation({
    mutationFn: () =>
      api.createUser({ username, role, ...(usePassword ? { password } : {}) }),
    onSuccess: onSaved,
  });

  return (
    <Card title="Create User Account" className="border-primary/30 shadow-lg">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            label={external?.available ? "Email" : "Username"}
            hint={
              external?.available
                ? `Use the email on their ${external.label} account. Sign-in is matched by email.`
                : "Letters, digits, dot, dash, underscore."
            }
          >
            <input
              className="input w-full rounded-xl text-sm"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </Field>
          {usePassword ? (
            <Field label="Initial Password" hint="User can change password after initial sign-in.">
              <PasswordInput
                className="input w-full rounded-xl text-sm"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
          ) : (
            <Field
              label="Password"
              hint={
                passwordLogin
                  ? `Not needed. They sign in with ${external?.label ?? "the provider"}.`
                  : "Signing in with a password is off on this server."
              }
            >
              <div className="flex h-12 items-center gap-2 text-xs text-base-content/65">
                <ShieldCheck size={14} className="shrink-0" />
                <span>{external?.label ?? "Provider"} only</span>
              </div>
            </Field>
          )}
          <Field label="Role">
            <select
              className="select w-full rounded-xl text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {ROLES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {external?.available && passwordLogin && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-base-content/70">
            <input
              type="checkbox"
              className="checkbox checkbox-xs"
              checked={withPassword}
              onChange={(e) => setWithPassword(e.target.checked)}
            />
            <span>Also give them a password (they can sign in without one)</span>
          </label>
        )}

        <p className="text-base-content/65 text-xs italic">
          {ROLES.find((entry) => entry.id === role)?.blurb}
        </p>
        <ErrorNote error={create.error} />

        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
            disabled={create.isPending}
          >
            {create.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            Create Account
          </button>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
