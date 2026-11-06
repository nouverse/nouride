import { createFileRoute } from "@tanstack/react-router";
import LlmGatewayPage from "@/modules/llm-gateway/index.page";
import { parseGatewaySearch, type GatewaySearch } from "@/modules/llm-gateway/search";

/** The gateway's own page in the URL (`?page=`), so a reload lands where the person was. */
export const Route = createFileRoute("/llm-gateway")({
  validateSearch: (search: Record<string, unknown>): GatewaySearch => parseGatewaySearch(search),
  // A frame that scrolls itself: given the whole height, never a scrolling document around it.
  staticData: { ownsViewport: true },
  component: LlmGatewayRoute,
});

function LlmGatewayRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <LlmGatewayPage
      search={search}
      onPage={(page) => void navigate({ search: page && page !== "/" ? { page } : {}, replace: true })}
    />
  );
}
