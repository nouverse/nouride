/**
 * Secrets — credentials by name, never by value.
 *
 * The page exists because config files reference a credential by name (`api_key = "nougate"`) and
 * something has to put the value behind that name without a redeploy. What it deliberately cannot do
 * is show one back: the daemon has no route that returns a secret, so this screen renders dots not
 * as a masking trick but because dots are the only thing on this side of the wire. A store that can
 * display its contents is one XSS away from being an exfiltration endpoint.
 *
 * ## What it is actually for
 *
 * Not "list the names" — the daemon's own log does that. The question somebody arrives with is
 * *"is the Discord token for Nox set, and is the value the one I put there?"*, and answering it takes
 * three facts a name alone does not carry:
 *
 * - **what uses it**, because the name is whatever was typed into `config.toml` a year ago;
 * - **whether it resolves at all**, so a missing credential reads as a missing credential rather than
 *   as a gateway that will not connect;
 * - **whether the environment is shadowing the store**, because resolution reads the environment
 *   first and a stored value under a shadowed name is a write that succeeded and changed nothing.
 *
 * The third is the one that wastes an afternoon, so it is a banner on the row rather than a footnote.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, Eye, Plus, RefreshCw } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { FieldChange, SecretEntry } from "@nouride/wire";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";
import { HELD_BOTTOM, ScrollCard } from "@/commons/components/ui/ScrollCard";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { BackupPasswordCard } from "./components/BackupPasswordCard";
import { LockNote } from "./components/LockNote";
import { SecretForm } from "./components/SecretForm";
import { plainUse, SecretRow } from "./components/SecretRow";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";
import { ListLoading } from "@/commons/components/ui/Spinner";

/**
 * What deleting a stored value does, said before it is done — and the part people read is that it cannot be put
 * back from here, since no route returns a value. Named by what uses it, so the person deleting `nougate` sees that
 * the provider called nougate is what stops working — and that an agent's commands lose it as well: deleting takes it
 * out of their `exec_secrets` (0.7.17).
 */
function deleteConsequence(entry: SecretEntry): string {
  if (entry.shadowed) {
    return `The server itself sets ${entry.name} too, and that one is used, so nothing changes; only the copy saved here goes. It cannot be shown or brought back from here.`;
  }
  const users = entry.usedBy.length > 0 ? `${entry.usedBy.map(plainUse).join(", ")} need it, and stop working without it` : "Nothing in your settings uses it now";
  return `${users}. A saved secret cannot be shown, so it cannot be brought back from here.`;
}

export default function SecretsPage() {
  const me = useMe();
  const secrets = useQuery({ queryKey: ["secrets"], queryFn: api.secrets });
  const queryClient = useQueryClient();

  /** The name being written, or `null`. A name means replace; the empty string means add. */
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const admin = isAdmin(me.data ?? null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["secrets"] });

  const save = useMutation({
    mutationFn: ({ name, value, fields }: { name: string; value: string; fields?: FieldChange }) => api.secretSet(name, value, fields),
    onSuccess: (result) => {
      setEditing(null);
      // Said out loud rather than swallowed: the write worked and resolution still returns the
      // environment's value, which looks exactly like the new value not working.
      setNotice(
        result.shadowedByEnv
          ? `Saved, but ${result.name} is also set on the server itself, and that one is still the one used.`
          : null,
      );
      void refresh();
    },
  });

  // A delete asks first (`confirm.tsx`): a stored value is write-only, so one deleted by a stray click is gone.
  const { ask, dialog } = useConfirm();
  const remove = useMutation({
    mutationFn: (name: string) => api.secretDelete(name),
    onSuccess: () => {
      setNotice(null);
      void refresh();
    },
  });

  // What is said about a secret, changed in its row; the value untouched (0.8.19). True when saved.
  const details = useMutation({
    mutationFn: ({ name, change }: { name: string; change: FieldChange }) => api.secretFields(name, change),
    onSuccess: () => void refresh(),
  });
  const saveDetails = async (name: string, change: FieldChange): Promise<boolean> => {
    if (!Object.keys(change.set ?? {}).length && !(change.remove ?? []).length) return true;
    try {
      await details.mutateAsync({ name, change });
      return true;
    } catch {
      return false;
    }
  };

  const entries = secrets.data?.secrets ?? [];
  const missing = entries.filter((entry) => entry.origin === "missing");
  // A secret found by its name, what uses it, or what is said about it: with forty of them, the one to replace was a
  // long scroll away.
  const [filter, setFilter] = useState("");
  const visible = useTextFilter(entries, filter, (entry) => [entry.name, ...entry.usedBy.map(plainUse), ...Object.entries(entry.fields ?? {}).flat(), entry.addedBy]);

  /**
   * The page owns the viewport (see `ownsViewport` in the layout): the header and the list's own
   * header with its Refresh stay where they are, and only the list scrolls — a box with forty
   * credentials otherwise scrolls the button you came for off the screen.
   *
   * The card keeps a minimum height, and the page itself still scrolls past it, so a short screen
   * with the form open loses nothing: it simply scrolls the old way. From a laptop's width up: on a phone the page
   * scrolls as a document, as every other does there.
   */
  return (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
    <div className={`mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-4 sm:px-6 sm:pt-6 lg:h-full lg:p-8 ${HELD_BOTTOM}`}>
      <PageHeader
        ask={PAGE_ASKS.secrets}
        className="shrink-0"
        pose={secrets.isPending || entries.length > 0 ? "security" : undefined}
        title="Secrets"
        description="The passwords and keys your agents and connections use. Add or replace one here; once saved, nobody can read it back, not even you."
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl gap-2 shadow-xs active:scale-95 transition-all"
            disabled={!admin}
            onClick={() => setEditing("")}
          >
            <Plus size={16} /> Add Secret
          </button>
        }
      />

      <ErrorNote error={secrets.error ?? save.error ?? remove.error ?? details.error} />

      {notice ? (
        <div className="alert alert-warning bg-warning/10 text-warning border border-warning/20 rounded-xl p-3 text-xs flex items-center gap-2">
          <AlertTriangle size={15} className="shrink-0" />
          <span className="font-medium">{notice}</span>
        </div>
      ) : null}

      {/**
       * The one thing a person is here to fix, before the list they would have to scan for it.
       *
       * A credential that nothing sets does not announce itself: it surfaces as a gateway that will
       * not connect, hours later, looking like a platform problem.
       */}
      {missing.length > 0 ? (
        <Card
          title={`${missing.length} ${missing.length === 1 ? "secret is" : "secrets are"} needed but not set`}
          description="Something in your settings needs these and nothing gives them a value, so it cannot sign in. Add them here."
        >
          <ul className="space-y-1.5">
            {missing.map((entry) => (
              <li key={entry.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <code className="font-mono text-error">{entry.name}</code>
                <span className="text-base-content/65">{entry.usedBy.map(plainUse).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {editing !== null ? (
        <SecretForm
          /** Non-empty means replace: the name is fixed and only a value is being asked for. */
          name={editing}
          pending={save.isPending}
          onCancel={() => setEditing(null)}
          onSubmit={(name, value, fields) => save.mutate({ name, value, ...(fields ? { fields } : {}) })}
        />
      ) : null}

      <ScrollCard
        fill
        title="Your secrets"
        description="Each one, where its value comes from, and what needs it."
        actions={
          <button
            type="button"
            className="btn btn-ghost btn-xs rounded-lg gap-1.5"
            onClick={() => void refresh()}
            disabled={secrets.isFetching}
          >
            <RefreshCw size={13} className={secrets.isFetching ? "animate-spin" : ""} /> Refresh
          </button>
        }
        {...(entries.length > 0 ? { search: { value: filter, onChange: setFilter, placeholder: "Search secrets" } } : {})}
      >
        {secrets.isPending ? (
          <ListLoading />
        ) : entries.length === 0 ? (
          <EmptyState
            pose="security"
            title="No secrets yet"
            description="Add one here, or have whoever runs the server set it there. Your settings use it by its name either way."
          />
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-base-content/65">Nothing matches “{filter}”.</p>
        ) : (
          <div className="space-y-2">
            {visible.map((entry: SecretEntry) => (
              <SecretRow
                key={entry.name}
                entry={entry}
                admin={admin}
                busy={remove.isPending || save.isPending || details.isPending}
                onReplace={() => setEditing(entry.name)}
                onSaveFields={(change) => saveDetails(entry.name, change)}
                onDelete={async () => {
                  if (await ask({ title: `Delete ${entry.name}?`, body: deleteConsequence(entry), confirmLabel: "Delete" })) remove.mutate(entry.name);
                }}
              />
            ))}
          </div>
        )}
      </ScrollCard>

      {/**
       * Stated on the page, not only in a code comment.
       *
       * Somebody will look for the reveal button, and "there isn't one" is a better answer when it
       * comes with the reason — otherwise it reads as a feature nobody got round to.
       */}
      <p className="flex shrink-0 items-start gap-2 text-xs text-base-content/65 px-1">
        <Eye size={13} className="shrink-0 mt-0.5" />
        <span>A saved secret cannot be shown again, here or anywhere, so nobody can read it out of this page. If you have lost one, replace it.</span>
      </p>
      <LockNote lock={secrets.data?.lock} />
      <BackupPasswordCard
        sealed={secrets.data?.sealedInSnapshots}
        admin={admin}
        onTurnOff={() =>
          ask({
            title: "Turn off the backup password?",
            body: "Backups from now on will not include your secrets. The backups made before keep theirs, locked with the old password.",
            confirmLabel: "Turn off",
          })
        }
      />
      {dialog}
    </div>
    </div>
  );
}
