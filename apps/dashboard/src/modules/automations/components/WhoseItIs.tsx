/**
 * Whose an automation is, set on its own page: a person in People, or nobody. An admin hands over any, and leaves one
 * with nobody: the ones nobody owns (made from the command line, or from before an automation was a person's) and one
 * that should be someone else's. Its own person hands theirs to somebody else, never to nobody: who made a morning
 * digest and passed the work on had to ask an admin to move it. Its person finds it on their own list and may change
 * it; what is nobody's is an admin's alone to change.
 *
 * An admin's pick is saved as it is made, as the Groups page's "who answers" is: the page then shows what the server
 * answered. A person's own hand-over is asked about first, since it is not theirs to take back, and the page is left
 * once it is done: it may no longer be one they can open. A refusal is said under the control in the server's words.
 * Someone in People with no account and no chat address has nothing an automation could be kept under: they are not
 * offered, and the card says why.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AutomationSummary } from "@nouride/wire";
import { useConfirm } from "@/commons/components/ui/confirm";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";
import { api } from "@/commons/lib/api";
import { isAdmin, useMe } from "@/commons/lib/session";

/** The list's value for nobody: no person's key is empty. */
const NOBODY = "";

export function WhoseItIs({ automation, onHanded }: { automation: Pick<AutomationSummary, "id" | "name" | "person">; /** Its own person gave it away: there may be no page of it for them to stay on. */ onHanded: () => void }) {
  const queryClient = useQueryClient();
  const saved = useSaved();
  const { ask, dialog } = useConfirm();
  const admin = isAdmin(useMe().data ?? null);
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, staleTime: 60_000 });
  const set = useMutation({
    mutationFn: (key: string) => api.cronOwner(automation.id, key === NOBODY ? null : key),
    onSuccess: (answer) => {
      const name = answer.job.person?.name;
      saved(answer, name ? `${automation.name} is ${name}'s now` : `${automation.name} is nobody's now`);
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      if (!admin) onHanded();
    },
  });

  const picked = automation.person?.key ?? NOBODY;
  const everyone = people.data?.people ?? [];
  const reachable = everyone.filter((person) => (person.ids?.length ?? 0) > 0 || person.key === picked).sort((a, b) => a.name.localeCompare(b.name));
  const left = everyone.filter((person) => !reachable.includes(person)).map((person) => person.name);
  // Its person is in the list from the first paint, before People has answered.
  const theirs = automation.person && !reachable.some((person) => person.key === picked) ? [{ value: picked, label: automation.person.name }] : [];
  // Nobody is an admin's to pick. Where the reader's own is kept under an account People does not name, it is "You".
  const first = admin ? [{ value: NOBODY, label: "Nobody" }] : automation.person ? [] : [{ value: NOBODY, label: "You" }];
  const options = [...first, ...theirs, ...reachable.map((person) => ({ value: person.key, label: person.name }))];

  const pick = async (next: string) => {
    if (next === picked) return;
    if (admin) return set.mutate(next);
    const to = options.find((option) => option.value === next)?.label ?? next;
    const yes = await ask({
      title: `Hand "${automation.name}" to ${to}?`,
      body: `It becomes ${to}'s to change, and is no longer yours. You still see it if it reports to a chat of yours.`,
      confirmLabel: "Hand it over",
      danger: false,
    });
    if (yes) set.mutate(next);
  };

  return (
    <div className="space-y-2" data-whose>
      {dialog}
      <h2 className="text-lg text-base-content">Whose it is</h2>
      <SearchSelect label="Whose it is" searchLabel="Find a person" noMatch={(typed) => `Nobody called “${typed}”`} options={options} value={picked} onChange={(next) => void pick(next)} align="start" className="w-full" disabled={set.isPending} />
      <p className="text-xs text-base-content/65">
        {admin
          ? automation.person
            ? `${automation.person.name} finds it on their own list and can change it, as an admin can.`
            : "Only an admin can change it. Pick a person to make it theirs."
          : "It is yours. Pick somebody else to hand it over: it is then theirs to change, and no longer yours."}
      </p>
      {left.length > 0 ? (
        <p className="text-xs text-base-content/65">
          Not listed: {left.join(", ")}. {left.length === 1 ? "They have" : "Each has"} no account or chat address in People yet.
        </p>
      ) : null}
      <ErrorNote error={set.error} />
    </div>
  );
}
