/**
 * Chats: the list of every conversation beside the one that is open.
 *
 * From a tablet's width up the two sit side by side. On a phone the list is the page until a conversation is opened,
 * and the conversation is then the whole screen with a way back (`chat-place.ts` tells the shell, which steps its own
 * header and tab bar aside). An address with nothing open — `/chat` on a laptop — is a new chat with the orchestrator,
 * as it always was; `/chat?agent=…` is a new chat with that agent.
 */

import { cn } from "@/commons/lib/utils";
import { ChatList } from "./components/ChatList";
import { Conversation } from "./components/Conversation";
import { GroupConversation } from "./components/GroupConversation";
import { useChatList } from "./hooks/use-chat-list";
import { groupKey } from "./lib/chat-list";

export default function ChatPage({
  sessionId,
  roomChatId,
  agent,
  draft,
  group,
}: {
  sessionId?: string;
  roomChatId?: string;
  agent?: string;
  draft?: string;
  group?: { platform: string; chatId: string };
} = {}) {
  const data = useChatList();
  // The same rule the shell reads from the address (`chatOpen`): a conversation, a room, a group, or a new chat named.
  const open = Boolean(sessionId || roomChatId || group || agent || draft);

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <ChatList
        data={data}
        open={{ ...(sessionId ? { sessionId } : {}), ...(roomChatId ? { roomChatId } : {}), ...(group ? { group: groupKey(group) } : {}) }}
        className={cn(
          "flex h-full min-h-0 w-full shrink-0 flex-col border-base-content/[0.08] bg-base-100/50 md:w-[19rem] md:border-r lg:w-[21rem]",
          open && "max-md:hidden",
        )}
      />
      <section aria-label="Conversation" className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col bg-base-100/30", !open && "max-md:hidden")}>
        {group ? (
          <GroupConversation key={groupKey(group)} platform={group.platform} chatId={group.chatId} data={data} />
        ) : (
          <Conversation
            {...(sessionId ? { sessionId } : {})}
            {...(roomChatId ? { roomChatId } : {})}
            {...(agent ? { agent } : {})}
            {...(draft ? { draft } : {})}
            data={data}
          />
        )}
      </section>
    </div>
  );
}
