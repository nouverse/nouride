/**
 * Whose an automation is, set by an admin on its own page: a person in People, or nobody. For the ones nobody owns
 * (made from the command line, or from before an automation was a person's) and for one that should be someone
 * else's. Its person finds it on their own list and may change it; what is nobody's is an admin's alone to change.
 *
 * Saved as it is picked, as the Groups page's "who answers" is: the page then shows what the server answered, and a
 * refusal is said under the control in the server's words. Someone in People with no account and no chat address has
 * nothing an automation could be kept under: they are not offered, and the card says why.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AutomationSummary } from "@nouride/wire";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";
import { api } from "@/commons/lib/api";
import { isAdmin, useMe } from "@/commons/lib/session";

/** The list's value for nobody: no person's key is empty. */
const NOBODY = "";

export function WhoseItIs({ automation }: { automation: Pick<AutomationSummary, "id" | "name" | "person"> }) {
  const queryClient = useQueryClient();
  const saved = useSaved();
  const admin = isAdmin(useMe().data ?? null);
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, staleTime: 60_000, enabled: admin });
  const set = useMutation({
    mutationFn: (key: string) => api.cronOwner(automation.id, key === NOBODY ? null : key),
    onSuccess: (answer) => {
      const name = answer.job.person?.name;
      saved(answer, name ? `${automation.name} is ${name}'s now` : `${automation.name} is nobody's now`);
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
    },
  });

  // An admin's alone: the server refuses anyone else, so nobody else is shown the choice.
  if (!admin) return null;
  const picked = automation.person?.key ?? NOBODY;
  const everyone = people.data?.people ?? [];
  const reachable = everyone.filter((person) => (person.ids?.length ?? 0) > 0 || person.key === picked).sort((a, b) => a.name.localeCompare(b.name));
  const left = everyone.filter((person) => !reachable.includes(person)).map((person) => person.name);
  // Its person is in the list from the first paint, before People has answered.
  const options = [{ value: NOBODY, label: "Nobody" }, ...(automation.person && !reachable.some((person) => person.key === picked) ? [{ value: picked, label: automation.person.name }] : []), ...reachable.map((person) => ({ value: person.key, label: person.name }))];

  return (
    <section aria-label="Whose it is" className="space-y-2 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft">
      <h2 className="text-lg text-base-content">Whose it is</h2>
      <SearchSelect
        label="Whose it is"
        searchLabel="Find a person"
        noMatch={(typed) => `Nobody called “${typed}”`}
        options={options}
        value={picked}
        onChange={(next) => {
          if (next !== picked) set.mutate(next);
        }}
        align="start"
        className="w-full"
        disabled={set.isPending}
      />
      <p className="text-xs text-base-content/65">
        {automation.person ? `${automation.person.name} finds it on their own list and can change it, as an admin can.` : "Only an admin can change it. Pick a person to make it theirs."}
      </p>
      {left.length > 0 ? (
        <p className="text-xs text-base-content/65">
          Not listed: {left.join(", ")}. {left.length === 1 ? "They have" : "Each has"} no account or chat address in People yet.
        </p>
      ) : null}
      <ErrorNote error={set.error} />
    </section>
  );
}
