/**
 * Groups — the rooms the agents talk in (0.7.24), beside People and built like it: one table, platform badges, inline
 * editing.
 *
 * A room is one chat on one platform where one conversation lives: a WhatsApp or Telegram group, a Discord channel, a
 * Discord thread (a room of its own), a dashboard room. Flat — no servers. Its name is what its platform calls it until
 * somebody renames it here; that name is what an agent's `send_message` takes, and what the agent is told the room is
 * called. Clearing a rename gives the platform's name back.
 */

import { platformName } from "@/commons/lib/platform";
import { isAdmin, useMe } from "@/commons/lib/session";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pencil } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { GroupRecord } from "@nouride/wire";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { FILL_PAGE, ScrollCard } from "@/commons/components/ui/ScrollCard";
import { useSaved } from "@/commons/hooks/use-saved";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

/** A room nobody named, by a short form of its id: what there is to tell two of them apart. */
function shortChatId(chatId: string): string {
  return chatId.length > 14 ? `${chatId.slice(0, 12)}…` : chatId;
}

export default function GroupsPage() {
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ["groups"], queryFn: api.groups });
  const me = useMe();
  const editable = isAdmin(me.data ?? null);
  const list = groups.data?.groups ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["groups"] });
  // A room found by any name it goes by, its platform, who talks there or which agents are in it: with many rooms, the
  // one to rename was a long scroll away.
  const [filter, setFilter] = useState("");
  const visible = useTextFilter(list, filter, (group) => [group.name, group.platformTitle, group.chatId, platformName(group.platform), ...group.agents, ...group.people.map((person) => person.name)]);

  return (
    <div className={FILL_PAGE}>
      <PageHeader
        ask={PAGE_ASKS.groups}
        title="Groups"
        description="The rooms your agents talk in: each group, channel, thread and dashboard room, with its own conversation. A room is called what its platform calls it; rename it here, and that is the name agents use for it."
      />

      {groups.isPending ? (
        <ListLoading />
      ) : groups.isError ? (
        <ErrorNote error={groups.error} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            pose="sleeping"
            title="No groups yet"
            description="A group appears here once an agent has talked in it. Add a bot to a WhatsApp or Telegram group or a Discord channel, or make a room in Chat."
          />
        </Card>
      ) : (
        <ScrollCard fill title="Known Rooms" description="One row per room. A Discord thread is a room of its own." search={{ value: filter, onChange: setFilter, placeholder: "Search groups" }}>
          {visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-base-content/65">Nothing matches “{filter}”.</p>
          ) : (
          <div className="overflow-x-auto -mx-4 -my-2 sm:-mx-6">
            {/* A card per room on a phone, the table from `sm` up, as People draws its rows: in four columns at a phone's
                width a room's name had a column a word wide. */}
            <table className="table table-sm block w-full sm:table">
              <thead className="bg-base-100 sticky top-0 z-10 hidden sm:table-header-group">
                <tr className="border-b border-base-content/[0.08] text-base-content/65 text-[11px] uppercase tracking-wider font-mono">
                  <th className="pl-6">Name</th>
                  <th>Agents</th>
                  <th>Who talks there</th>
                  <th className="text-right pr-6">Actions</th>
                </tr>
              </thead>
              <tbody className="block divide-y divide-base-content/[0.06] sm:table-row-group">
                {visible.map((group) => (
                  <GroupRow key={`${group.platform}:${group.chatId}`} group={group} editable={editable} onChanged={refresh} />
                ))}
              </tbody>
            </table>
          </div>
          )}
        </ScrollCard>
      )}
    </div>
  );
}

function GroupRow({ group, editable, onChanged }: { group: GroupRecord; editable: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(group.name ?? "");
  const saved = useSaved();
  const rename = useMutation({
    mutationFn: (next: string) => api.renameGroup({ gatewayId: group.gatewayId, chatId: group.chatId, title: next }),
    onSuccess: (answer, next) => {
      saved(answer, next.trim() ? `Renamed to ${next.trim()}` : "Rename cleared");
      setEditing(false);
      onChanged();
    },
  });
  // A rename is only undone where there is something to go back to: the platform's name. A dashboard room's title is its own.
  const renamed = !group.dashboard && Boolean(group.name) && group.name !== group.platformTitle;

  return (
    <tr className="block py-2 hover:bg-base-200/40 transition-colors sm:table-row sm:py-0">
      <td className="block px-4 py-1.5 align-top max-sm:border-0 sm:table-cell sm:py-3 sm:pl-6 sm:pr-3">
        {editing ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              rename.mutate(title);
            }}
          >
            <input
              className="input input-sm w-56 max-w-full text-sm rounded-xl"
              value={title}
              placeholder={group.platformTitle ?? "Name this room"}
              aria-label="Room name"
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn btn-primary btn-xs rounded-lg" disabled={rename.isPending}>
              {rename.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
              Save
            </button>
            <button type="button" className="btn btn-ghost btn-xs rounded-lg" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <ErrorNote error={rename.error} />
          </form>
        ) : (
          <div className="flex items-start gap-2">
            <span className="badge badge-sm badge-ghost font-semibold shrink-0 font-mono mt-0.5">{group.dashboard ? "Dashboard" : platformName(group.platform)}</span>
            <div className="min-w-0">
              <div className="font-semibold text-sm text-base-content break-words">{group.name ?? <span className="text-base-content/65 font-normal">Unnamed</span>}</div>
              <div className="font-mono text-[11px] text-base-content/65 break-all" title={`${group.gatewayId}:${group.chatId}`}>
                {renamed && group.platformTitle ? `on ${platformName(group.platform)}: ${group.platformTitle} · ` : ""}
                {shortChatId(group.chatId)}
              </div>
            </div>
          </div>
        )}
      </td>
      <td className="block px-4 py-1.5 text-xs align-top max-sm:border-0 sm:table-cell sm:px-3 sm:py-3">
        {group.agents.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {group.agents.map((agent) => (
              <span key={agent} className="badge badge-sm badge-outline font-mono">
                {agent}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-base-content/65">—</span>
        )}
      </td>
      <td className="block px-4 py-1.5 text-xs text-base-content/80 align-top max-sm:border-0 sm:table-cell sm:px-3 sm:py-3">
        {/* Named on a phone, where there is no column header to say what the names are. */}
        <span className="text-base-content/65 sm:hidden">Who talks there: </span>
        {group.people.length > 0 ? (
          group.people.map((person) => person.name).join(", ")
        ) : (
          <span className="text-base-content/65">Nobody yet</span>
        )}
      </td>
      <td className="block px-4 py-1.5 align-top max-sm:border-0 sm:table-cell sm:py-3 sm:pr-6 sm:pl-3 sm:text-right">
        {editable && !editing ? (
          <div className="flex items-center gap-1 sm:justify-end">
            <button
              type="button"
              className="btn btn-ghost btn-xs rounded-lg font-medium hover:bg-base-200"
              onClick={() => {
                setTitle(group.name ?? "");
                setEditing(true);
              }}
            >
              <Pencil size={12} /> Rename
            </button>
            {renamed ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs rounded-lg font-medium"
                disabled={rename.isPending}
                title={`Go back to what ${platformName(group.platform)} calls it`}
                onClick={() => rename.mutate("")}
              >
                Use {platformName(group.platform)}'s name
              </button>
            ) : null}
          </div>
        ) : null}
      </td>
    </tr>
  );
}
