import { GatewayList } from "./components/GatewayList";

export default function AgentGatewaysPage({ agentId }: { agentId: string }) {
  return <GatewayList agentId={agentId} />;
}
