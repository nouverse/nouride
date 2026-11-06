/**
 * Where a remote MCP server's login comes back to (0.7.19): the address the authorization server sent the browser to
 * is handed to the daemon, which finishes the login — and what came of it is said here, with the way back to the
 * server's card.
 *
 * Handed over once, whatever the page does after: a login is good for one finish, and asking again would report a
 * failure over a login that worked. A login started from a terminal is finished there — this page's address is what
 * `nouride mcp login` asks for, so a failure here shows it to copy, under Details: the people who read this page are
 * not technical (0.8.19), and the terminal is for whoever runs the server.
 */

import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Details } from "@/commons/components/ui/Details";

export default function McpLoginCallbackPage() {
  const address = typeof window === "undefined" ? "" : window.location.href;
  const finish = useMutation({ mutationFn: () => api.finishMcpLogin({ url: address }) });
  const handedOver = useRef(false);
  const { mutate } = finish;
  useEffect(() => {
    if (handedOver.current) return;
    handedOver.current = true;
    mutate();
  }, [mutate]);

  const done = finish.data;
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="card bg-base-100 border border-base-content/[0.08] shadow-xs rounded-2xl max-w-lg w-full">
        <div className="card-body gap-4">
          {done ? (
            <>
              <h1 className="flex items-center gap-2 text-lg font-semibold">
                <CheckCircle2 className="text-success" size={20} /> {done.server} is logged in
              </h1>
              <p className="text-sm text-base-content/75">
                {done.holder === "shared" ? "Every agent that uses the library's login" : done.holder} is connecting to it now
                {done.scope ? `, with ${done.scope}` : ""}. Its tools are offered from the next turn.
              </p>
              {done.holder === "shared" ? (
                <Link to="/mcp" className="btn btn-primary btn-sm rounded-xl self-start">
                  Back to Connectors
                </Link>
              ) : (
                <Link to="/agents/$agentId/mcp" params={{ agentId: done.holder }} className="btn btn-primary btn-sm rounded-xl self-start">
                  Back to {done.holder}'s connectors
                </Link>
              )}
            </>
          ) : finish.isError ? (
            <>
              <h1 className="flex items-center gap-2 text-lg font-semibold">
                <TriangleAlert className="text-warning" size={20} /> The login did not finish here
              </h1>
              <p className="text-sm text-base-content/75">{finish.error.message}</p>
              <Details>
                <p>
                  Started from a terminal with <code>nouride mcp login</code>? Paste this page's address there; it carries the answer:
                </p>
                <code className="block break-all rounded-lg bg-base-200/60 p-3 text-xs">{address}</code>
              </Details>
              <Link to="/agents" className="btn btn-ghost btn-sm rounded-xl self-start">
                Agents
              </Link>
            </>
          ) : (
            <p className="flex items-center gap-3 text-sm text-base-content/75">
              <span className="loading loading-spinner loading-sm text-primary" /> Finishing the login…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
