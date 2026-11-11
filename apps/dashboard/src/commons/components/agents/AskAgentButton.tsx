/**
 * "Ask Nouva to set it up" (0.8.19): where the dashboard cannot do a thing itself and the orchestrator can, a button
 * that opens the chat with the orchestrator, a message already written in the box. Nothing is sent from here: the person
 * reads it, changes it if they like, and presses send; and the agent still asks before it installs anything, as it
 * always does. It replaces a command printed for a person to type, which a person who is not technical cannot use.
 *
 * The chat takes the message from its address once and drops it from there (`commons/lib/start-with.ts`). Drawn
 * once the orchestrator is known, since its name is on the button: "Ask your orchestrator" asks a person to know the word.
 * Not for a viewer, who may read the dashboard but send nothing, a chat message included.
 *
 * `soft` is the one in a page's header (`PageHeader`'s `ask`, words in `page-asks.ts`): beside the page's own main
 * button it is the quieter of the two, and on a phone it says only "Ask Nouva", the rest in its title.
 */

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { cn } from "@/commons/lib/utils";

/** `task` finishes the label after the agent's name: "to set it up" reads "Ask Nouva to set it up". */
export function AskAgentButton({
  task,
  message,
  className,
  variant = "primary",
}: {
  task: string;
  message: string;
  className?: string;
  variant?: "primary" | "soft";
}) {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const me = useMe();
  const orchestrator = status.data?.orchestrator;
  const name = status.data?.agents.find((agent) => agent.id === orchestrator)?.displayName;
  if (!orchestrator || !name || !canWrite(me.data ?? null)) return null;
  const look = variant === "soft" ? "btn btn-sm gap-1.5 rounded-xl border-0 bg-secondary/10 text-secondary hover:bg-secondary/20" : "btn btn-primary btn-sm gap-1.5 rounded-xl";
  return (
    <Link to="/chat" search={{ agent: orchestrator, draft: message }} title={`Ask ${name} ${task}`} className={cn(look, className)}>
      <MessageSquare size={14} aria-hidden="true" />
      {variant === "soft" ? (
        <>
          <span className="sm:hidden">Ask {name}</span>
          <span className="hidden sm:inline">
            Ask {name} {task}
          </span>
        </>
      ) : (
        <>
          Ask {name} {task}
        </>
      )}
    </Link>
  );
}
