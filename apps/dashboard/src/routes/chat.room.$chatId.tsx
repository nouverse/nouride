import { createFileRoute } from "@tanstack/react-router";
import ChatPage from "@/modules/chat/index.page";

/**
 * A room, addressed by its chat id.
 *
 * Not by a session id like a one-to-one conversation, because a room has none until somebody has
 * spoken in it — sessions are created per agent on their first turn, so a room created a second ago
 * has zero of them and would be unopenable.
 */
export const Route = createFileRoute("/chat/room/$chatId")({
  component: ChatRoomRoute,
});

function ChatRoomRoute() {
  const { chatId } = Route.useParams();
  return <ChatPage roomChatId={chatId} />;
}
