import { createFileRoute } from "@tanstack/react-router";
import ChatPage from "@/modules/chat/index.page";
import { parseChatSearch, type ChatSearch } from "@/modules/chat/lib/start-with";

/** Two search parameters: the agent a new chat starts with (the Office's Open chat), and a draft for the box. */
export const Route = createFileRoute("/chat/")({
  validateSearch: (search: Record<string, unknown>): ChatSearch => parseChatSearch(search),
  component: ChatIndexRoute,
});

function ChatIndexRoute() {
  const { agent, draft } = Route.useSearch();
  return <ChatPage {...(agent ? { agent } : {})} {...(draft ? { draft } : {})} />;
}
