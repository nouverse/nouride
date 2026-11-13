/**
 * The model and the effort a conversation with one agent is answered with, picked in its bar.
 *
 * `/model` and `/effort` were the only way, and nobody finds a command: somebody asked whether an agent's model could
 * be set from the chat at all. The button says what the conversation is on, and its panel picks another: for this
 * conversation only, the agent's own everywhere else. A pick is in force from the next message.
 *
 * A conversation not begun has no row to keep a pick on, so its pick is the page's until the first message, which it
 * goes with (`first`). One that has begun keeps its own on the daemon, where the commands keep theirs: the panel reads
 * what a command set, and a command what the panel picked.
 *
 * The model field is the agent's Model tab's: it suggests, and takes any name typed. An agent a coding CLI answers
 * picks among the models its CLI offers; before the CLI has listed any, the panel says where its model is set.
 */

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import type { ChatChoices } from "@nouride/wire";
import { Combobox } from "@/commons/components/ui/Combobox";
import { PopoverSheet } from "@/commons/components/ui/PopoverSheet";
import { ErrorNote, Field } from "@/commons/components/ui/ui";
import { api } from "@/commons/lib/api";
import { chatModels } from "@/commons/lib/model-kind";
import { cn } from "@/commons/lib/utils";

/** A new conversation's pick, kept by its page until the first message takes it. */
export interface FirstChoice {
  model?: string;
  effort?: string;
}

/** One pick: a value, or null for the agent's own back. A field left out stays as it is. */
type Change = { model?: string | null; effort?: string | null };

/** What the conversation is answered with now: its own pick where it has one, else the agent's. */
function inForce(view: ChatChoices, picked: FirstChoice): { model: string; effort: string | undefined; picked: boolean } {
  return { model: picked.model ?? view.model.own, effort: picked.effort ?? view.effort.own, picked: picked.model !== undefined || picked.effort !== undefined };
}

/** A new conversation's pick after one change: null is the agent's own back. */
function changed(first: FirstChoice, change: Change): FirstChoice {
  const next: FirstChoice = { ...first };
  if (change.model !== undefined) {
    if (change.model === null) delete next.model;
    else next.model = change.model;
  }
  if (change.effort !== undefined) {
    if (change.effort === null) delete next.effort;
    else next.effort = change.effort;
  }
  return next;
}

export function ChatChoice({
  agentId,
  name,
  sessionId,
  first,
  onFirst,
  buttonClassName,
}: {
  agentId: string;
  name: string;
  sessionId: string | undefined;
  first: FirstChoice;
  onFirst: (next: FirstChoice) => void;
  buttonClassName: string;
}) {
  const queryClient = useQueryClient();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  /** The model's name while it is being typed; null follows what is in force. */
  const [typed, setTyped] = useState<string | null>(null);

  const key = ["chat-choices", sessionId ?? `agent:${agentId}`];
  const choices = useQuery({
    queryKey: key,
    queryFn: () => api.chatChoices(sessionId ? { session: sessionId } : { agent: agentId }),
    // A new chat's agent is known a moment after its page is drawn: nothing is asked about nobody.
    enabled: Boolean(sessionId || agentId),
    retry: false,
    staleTime: 30_000,
  });
  const view = choices.data;
  const cli = view?.cli;

  // Its provider's own list, asked for once the panel is open. A coding CLI's agent has its list in `view`.
  const listed = useQuery({
    queryKey: ["chat-models", agentId],
    queryFn: () => api.chatModels(agentId),
    enabled: open && view !== undefined && !cli,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const pick = useMutation({
    mutationFn: (change: Change) => api.chooseInChat({ sessionId: sessionId!, ...change }),
    onSuccess: (answer) => {
      queryClient.setQueryData(key, answer);
      setTyped(null);
    },
  });

  // A daemon from before the picker answers nothing here: no button, where a dead one would be worse. And an answer
  // that is not the picker's (a proxy's page, another version's) is no picker either: read as one, it took the whole
  // conversation off the page with it.
  if (!view?.model || !Array.isArray(view.efforts)) return null;

  const picked: FirstChoice = sessionId ? { ...(view.model.chosen ? { model: view.model.chosen } : {}), ...(view.effort.chosen ? { effort: view.effort.chosen } : {}) } : first;
  const now = inForce(view, picked);
  /** Kept by the daemon for a conversation that has begun, by the page for one that has not. */
  const choose = (change: Change) => {
    if (sessionId) return pick.mutate(change);
    onFirst(changed(first, change));
    setTyped(null);
  };
  const named = (value: string) => cli?.models.find((entry) => entry.value === value)?.name;
  // The model by the name its CLI gives it; where nothing says which, the CLI's own.
  const label = [named(now.model) ?? (now.model || (cli ? `${cli.name}'s own` : "")), now.effort].filter(Boolean).join(" · ");

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cn(buttonClassName, (open || now.picked) && "bg-secondary/10 text-secondary")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Model and effort for this conversation: ${label}`}
        data-picked={now.picked ? "" : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <Sparkles size={17} aria-hidden="true" />
        <span className="max-w-44 truncate font-mono text-xs font-medium max-lg:hidden">{label}</span>
      </button>

      <PopoverSheet open={open} onClose={() => { setOpen(false); setTyped(null); }} anchor={anchor} label="Model and effort for this conversation" width={360}>
        <ChoicePanel
          agentId={agentId}
          name={name}
          view={view}
          picked={picked}
          model={typed ?? now.model}
          typed={typed}
          onType={setTyped}
          options={cli ? cli.models.map((entry) => entry.value) : chatModels(listed.data?.models ?? [])}
          named={named}
          loading={listed.isLoading}
          busy={pick.isPending}
          error={pick.error}
          choose={choose}
          onLeave={() => setOpen(false)}
        />
      </PopoverSheet>
    </>
  );
}

/** The panel: the model's field, its way back to the agent's own, and the levels. Each pick goes out as it is made. */
function ChoicePanel({
  agentId,
  name,
  view,
  picked,
  model,
  typed,
  onType,
  options,
  named,
  loading,
  busy,
  error,
  choose,
  onLeave,
}: {
  agentId: string;
  name: string;
  view: ChatChoices;
  /** What this conversation picked over the agent's own. */
  picked: FirstChoice;
  /** What the model's field holds: what is typed, else what is in force. */
  model: string;
  typed: string | null;
  onType: (text: string) => void;
  options: string[];
  named: (value: string) => string | undefined;
  loading: boolean;
  busy: boolean;
  error: unknown;
  choose: (change: Change) => void;
  /** A link out of the panel was followed. */
  onLeave: () => void;
}) {
  const cli = view.cli;
  const cliName = cli?.name ?? "";
  const noList = cli !== undefined && cli.models.length === 0;
  const ownEffort = view.effort.own ? `${name}'s own (${view.effort.own})` : `${name}'s own`;
  const chooseModel = (value: string) => {
    const said = value.trim();
    // Its own name picked is its own back, not a pick that happens to say the same.
    choose({ model: said === "" || said === view.model.own ? null : said });
  };

  return (
    <form
      className="flex flex-col gap-4 overflow-y-auto overscroll-contain p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed !== null) chooseModel(typed);
      }}
    >
      <div>
        <p className="font-display text-base font-medium">Model and effort</p>
        <p className="mt-0.5 text-xs text-base-content/65">For this conversation only, from your next message. Everywhere else {name} keeps its own.</p>
      </div>

      <Field label="Model" hint={noList ? `${cliName} lists its models after its first answer.` : cli ? `One ${cliName} offers, or another name it takes.` : "Search, or type a model's name and press Enter."}>
        <Combobox options={options} describe={named} loading={loading} value={model} onChange={onType} onPick={chooseModel} disabled={busy} placeholder={cli ? `${cliName}'s own` : view.model.own} />
      </Field>
      {noList ? (
        <p className="-mt-2 text-xs text-base-content/65">
          Until then its model is set on{" "}
          <Link to="/agents/$agentId/cli" params={{ agentId }} className="link link-secondary font-semibold" onClick={onLeave}>
            {name}'s own page
          </Link>
          .
        </p>
      ) : null}
      {picked.model !== undefined ? (
        <button type="button" className="btn btn-ghost btn-sm -mt-2 justify-start rounded-xl px-2 text-secondary" disabled={busy} onClick={() => choose({ model: null })}>
          Back to {name}'s own{view.model.own ? ` (${named(view.model.own) ?? view.model.own})` : ""}
        </button>
      ) : null}

      {/* Not a `Field`: that is a label, and a press on a label's words presses its first control, which here is a pick. */}
      <div className="space-y-1.5">
        <span id="chat-choice-effort" className="block font-mono text-xs font-semibold uppercase tracking-wider text-base-content/85">
          Effort
        </span>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby="chat-choice-effort">
          {[null, ...view.efforts].map((level) => {
            const checked = (picked.effort ?? null) === level;
            return (
              <button
                key={level ?? "own"}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={busy}
                onClick={() => choose({ effort: level })}
                className={cn("btn btn-xs min-h-8 rounded-lg", level ? "font-mono" : "", checked ? "btn-primary" : "btn-ghost border border-base-content/10")}
              >
                {level ?? ownEffort}
              </button>
            );
          })}
        </div>
        <span className="block text-xs leading-normal text-base-content/65">
          {view.effort.refusedBy ? `${view.effort.refusedBy} did not take ${view.effort.chosen}, so it is asked for none.` : "How long the model thinks before it answers."}
        </span>
      </div>

      <ErrorNote error={error} />
    </form>
  );
}
