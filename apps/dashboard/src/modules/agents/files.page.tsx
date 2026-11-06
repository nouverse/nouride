import { canWrite, useMe } from "@/commons/lib/session";
import { FileEditor } from "./components/FileEditor";

export default function AgentFilesPage({ agentId }: { agentId: string }) {
  const me = useMe();
  return <FileEditor agent={agentId} editable={canWrite(me.data ?? null)} />;
}
