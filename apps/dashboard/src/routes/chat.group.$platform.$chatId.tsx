import { createFileRoute } from "@tanstack/react-router";
import ChatPage from "@/modules/chat/index.page";

/**
 * A group from a chat app, by its app and its chat: the same group whichever of our bots heard it. Read here, answered
 * on its app.
 */
export const Route = createFileRoute("/chat/group/$platform/$chatId")({
  component: ChatGroupRoute,
});

function ChatGroupRoute() {
  const { platform, chatId } = Route.useParams();
  return <ChatPage group={{ platform, chatId }} />;
}
