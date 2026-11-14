/**
 * The agents' workspace, to look through: all of it under the Agents menu's Workspace tab, and one agent's own folder
 * under that agent's Workspace tab. The same files view as System's Files, held to the folder it is about: there is no
 * way up or out of it, and the tab over all of it goes into `private` and `shared` and lists nothing else.
 *
 * An admin's, as Files is: what agents keep in their folders is not for everyone who can open the dashboard.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { FilesBrowser } from "@/commons/components/files/FilesBrowser";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { FILL_PAGE } from "@/commons/components/ui/ScrollCard";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { isAdmin, useMe } from "@/commons/lib/session";
import { agentFolder, WORKSPACE_FOLDERS } from "./lib/workspace";

interface Props {
  path: string;
  onOpen: (path: string) => void;
  /** One agent's own folder; absent, the whole workspace. */
  agentId?: string;
}

/** The files view over the workspace, or over one agent's folder in it. */
function WorkspaceFiles({ path, onOpen, agentId }: Props) {
  const admin = isAdmin(useMe().data ?? null);
  const where = useQuery({ queryKey: ["system", "workspace"], queryFn: api.systemWorkspace, staleTime: 5 * 60_000, retry: false, enabled: admin });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status, enabled: admin && agentId !== undefined });
  if (!admin) return <EmptyState pose="searching" title="For an admin" description="What agents keep in their folders is an admin's to look at." />;
  if (where.error) return <ErrorNote error={where.error} />;
  if (!where.data) return <ListLoading />;
  if (where.data.path === null) return <EmptyState pose="searching" title="Not shown here" description="On this server the workspace is kept apart from the rest of Nouride's files, so it cannot be looked through here." />;
  const name = agentId === undefined ? "Workspace" : `${status.data?.agents.find((agent) => agent.id === agentId)?.displayName || agentId}'s folder`;
  const root = { path: agentId === undefined ? where.data.path : agentFolder(where.data.path, agentId), name };
  return <FilesBrowser path={path} onOpen={onOpen} root={root} {...(agentId === undefined ? { only: WORKSPACE_FOLDERS } : {})} />;
}

/** An agent's Workspace tab: that agent's own folder. */
export default function AgentWorkspacePage({ agentId, path, onOpen }: Required<Props>) {
  return (
    <Card title="Workspace" description="This agent's own folder: what it made and keeps while it works. Other agents do not read it.">
      <div className="flex min-h-[22rem] flex-col" data-workspace="agent">
        <WorkspaceFiles agentId={agentId} path={path} onOpen={onOpen} />
      </div>
    </Card>
  );
}

/** The Agents menu's Workspace tab: every agent's own folder, and the one they share. */
export function WorkspacePage({ path, onOpen }: Pick<Props, "path" | "onOpen">) {
  return (
    <div className={FILL_PAGE}>
      <PageHeader title="Workspace" description="Where your agents work: each agent's own folder, and the one they share." />
      <Card className="lg:flex lg:min-h-[22rem] lg:flex-1 lg:flex-col" bodyClassName="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        <div className="flex min-h-0 flex-col lg:flex-1" data-workspace="all">
          <WorkspaceFiles path={path} onOpen={onOpen} />
        </div>
      </Card>
    </div>
  );
}
