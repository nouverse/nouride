import { createFileRoute } from "@tanstack/react-router";
import McpLoginCallbackPage from "@/modules/agents/mcp-login-callback.page";

export const Route = createFileRoute("/oauth/mcp/callback")({ component: McpLoginCallbackPage });
