import { createFileRoute } from "@tanstack/react-router";
import ChatPage from "@/modules/chat/index.page";

/**
 * No search parameters.
 *
 * There used to be one — `?initialMessage=…` — and it was the auto-send-on-refresh bug: the message
 * was in the URL, so every reload sent it again. A conversation is addressed by its id and nothing
 * else; the message lives in the daemon from the moment it is accepted.
 */
export const Route = createFileRoute("/chat/$sessionId")({
  component: ChatSessionRoute,
});

function ChatSessionRoute() {
  const { sessionId } = Route.useParams();
  return <ChatPage sessionId={sessionId} />;
}
