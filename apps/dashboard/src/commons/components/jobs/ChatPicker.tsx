/**
 * Where a job's results go: a connection, then a chat on it — each chat offered as what it is ("DM · Gading", "Group ·
 * Nouride"), not a bare id (0.8.0). The Schedule form offered `5550001111` beside `-1005550002` and the Webhooks form
 * asked for an id typed by hand; this is the one picker for both, and an id nobody knows can still be typed.
 */

import { Combobox } from "@/commons/components/ui/Combobox";
import { Field } from "@/commons/components/ui/ui";
import type { GatewayInstance } from "@/commons/lib/api";
import { useKnownChats } from "@/commons/hooks/use-known-chats";

export function ChatPicker({
  gateways,
  gatewayId,
  onGateway,
  chatId,
  onChat,
  recent = [],
}: {
  gateways: GatewayInstance[];
  gatewayId: string;
  onGateway: (gatewayId: string) => void;
  chatId: string;
  onChat: (chatId: string) => void;
  /** Chats with a conversation lately, offered too — one the daemon cannot name shows its id alone. */
  recent?: { gatewayId: string; chatId: string }[];
}) {
  const { chats, labelOf } = useKnownChats();
  const options = [
    ...new Set([...chats, ...recent].filter((chat) => chat.gatewayId === gatewayId).map((chat) => chat.chatId)),
  ];
  const chosen = chatId.trim() ? labelOf(gatewayId, chatId.trim()) : undefined;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Connection" hint="One bot or number, not a whole chat app.">
        <select className="select select-sm w-full rounded-xl font-mono text-xs" value={gatewayId} onChange={(e) => onGateway(e.target.value)}>
          {gateways.length === 0 && <option value="">no connections configured</option>}
          {gateways.map((gateway) => (
            <option key={gateway.id} value={gateway.id}>
              {gateway.id}
              {gateway.enabled ? "" : " (disabled)"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Chat" hint={chosen ? `${chosen} (${chatId.trim()})` : "A one-to-one or a group on this connection. One not listed can be typed as its id."}>
        <Combobox
          options={options}
          value={chatId}
          onChange={onChat}
          describe={(id) => labelOf(gatewayId, id)}
          placeholder="Pick a chat, or type its id"
          customHint="use this id"
          required
          listOnFocus
        />
      </Field>
    </div>
  );
}
