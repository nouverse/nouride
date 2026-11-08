/**
 * "Ask Nouva to set it up" (0.8.19): where the dashboard cannot do a thing itself and the orchestrator can, a button
 * that opens the chat with the orchestrator, a message already written in the box. Nothing is sent from here: the person
 * reads it, changes it if they like, and presses send; and the agent still asks before it installs anything, as it
 * always does. It replaces a command printed for a person to type, which a person who is not technical cannot use.
 *
 * The chat takes the message from its address once and drops it from there (`modules/chat/lib/start-with.ts`). Drawn
 * once the orchestrator is known, since its name is on the button: "Ask your orchestrator" asks a person to know the word.
 */

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { api } from "@/commons/lib/api";
import { cn } from "@/commons/lib/utils";

/** `task` finishes the label after the agent's name: "to set it up" reads "Ask Nouva to set it up". */
export function AskAgentButton({ task, message, className }: { task: string; message: string; className?: string }) {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const orchestrator = status.data?.orchestrator;
  const name = status.data?.agents.find((agent) => agent.id === orchestrator)?.displayName;
  if (!orchestrator || !name) return null;
  return (
    <Link to="/chat" search={{ agent: orchestrator, draft: message }} className={cn("btn btn-primary btn-sm gap-1.5 rounded-xl", className)}>
      <MessageSquare size={14} aria-hidden="true" /> Ask {name} {task}
    </Link>
  );
}
