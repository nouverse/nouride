/**
 * A remote MCP server's login (0.7.19): "needs login" and Connect; the scope it is logged in with, and Log out; and
 * after Connect, where to paste the address the browser landed on — for a browser that cannot reach this daemon's own
 * address, which without `[dashboard] public_url` is every browser not on this machine.
 *
 * The library's login (Configure → MCP), which every agent without one of its own uses — or one agent's own.
 */

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { KeyRound, LogIn, LogOut } from "lucide-react";
import { api, ApiError } from "@/commons/lib/api";
import type { McpLoginScope, McpServer } from "@nouride/wire";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";
import { isAdmin, useMe } from "@/commons/lib/session";

/** What the card says about a server's login — null for one with nothing to log in to. */
export function loginLine(server: Pick<McpServer, "transport" | "needsLogin" | "login">): string | null {
  if (server.transport === "stdio") return null;
  if (server.needsLogin) return server.login ? "Its login stopped working. Log in again to use its tools." : "Needs a login before its tools work.";
  if (server.login) return connectedLine(server.login);
  return null;
}

/**
 * Who pressed Connect, where, and when — never the account inside the service. Nouride holds only the token the service
 * gave; which Notion (or Linear…) account it belongs to is the service's to say. "Logged in with default by
 * account@nouverse.tech" read as the Notion account, which it was not: the address is the dashboard user, "default" the
 * scope Notion grants. A scope is said only when it says something.
 */
function connectedLine(login: NonNullable<McpServer["login"]>): string {
  const when = new Date(login.loggedInAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  // A login finished in a terminal on the server (`nouride mcp login`) is said as that, not by its command (0.8.19).
  const who = login.loggedInBy === "cli" ? "on the server itself" : `by ${login.loggedInBy} from the dashboard`;
  const scope = login.scope?.trim();
  return `Connected: ${who}, ${when}.${scope && scope !== "default" ? ` Access: ${scope}.` : ""}`;
}

/**
 * An authorization server that registers no clients itself: the login needs one registered with it by hand. Read off
 * the route's own words, which the page says in its own beside them since 0.8.20.
 */
export const needsClientId = (error: unknown): boolean =>
  error instanceof Error && (error instanceof ApiError ? (error.server?.error ?? error.message) : error.message).includes("needs a client id");

export function McpServerLogin({
  scope,
  server,
  onChanged,
}: {
  scope: McpLoginScope;
  server: Pick<McpServer, "name" | "transport" | "needsLogin" | "login">;
  onChanged: () => void;
}) {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const [started, setStarted] = useState<string | null>(null);
  const [landed, setLanded] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const { ask, dialog } = useConfirm();

  const connect = useMutation({
    mutationFn: async () => {
      // Opened in the click, before the request: a tab opened after an await is a popup the browser blocks.
      const tab = window.open("", "_blank");
      try {
        const client = clientId.trim() ? { clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) } : undefined;
        const { url } = await api.startMcpLogin(scope, server.name, client);
        if (tab) {
          // The login page must not reach back into this one.
          tab.opener = null;
          tab.location.href = url;
        }
        setStarted(url);
      } catch (err) {
        tab?.close();
        throw err;
      }
    },
  });
  const finish = useMutation({
    mutationFn: () => api.finishMcpLogin({ url: landed.trim() }),
    onSuccess: () => {
      setStarted(null);
      setLanded("");
      onChanged();
    },
  });
  const logout = useMutation({ mutationFn: () => api.logoutMcpServer(scope, server.name), onSuccess: onChanged });
  const who = "library" in scope ? "every agent that uses the library's login" : scope.agentId;

  const line = loginLine(server);
  if (!line) return null;
  const waiting = Boolean(server.needsLogin);
  return (
    <div className="col-span-full p-3 rounded-xl bg-base-200/40 border border-base-content/[0.05] space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={waiting ? "text-warning text-sm font-medium" : "text-base-content/75 text-sm"}>{line}</p>
        <div className="flex items-center gap-2">
          {admin && waiting && (
            <button type="button" className="btn btn-primary btn-xs rounded-lg gap-1.5" disabled={connect.isPending} onClick={() => connect.mutate()}>
              <LogIn size={14} /> Connect
            </button>
          )}
          {admin && server.login && (
            <button
              type="button"
              className="btn btn-ghost btn-xs rounded-lg gap-1.5"
              disabled={logout.isPending}
              onClick={async () => {
                const yes = await ask({
                  title: `Log ${server.name} out?`,
                  body: `Its sign-in is deleted, and ${who} cannot use its tools until somebody logs in again.`,
                  confirmLabel: "Log out",
                });
                if (yes) logout.mutate();
              }}
            >
              <LogOut size={14} /> Log out
            </button>
          )}
        </div>
      </div>
      {admin && waiting && needsClientId(connect.error) && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input className="input input-sm rounded-lg" placeholder="Client ID registered with the server" value={clientId} onChange={(event) => setClientId(event.target.value)} />
          <input className="input input-sm rounded-lg" type="password" placeholder="Its client secret (if it has one)" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
        </div>
      )}
      {started && waiting && (
        <div className="space-y-2 text-sm text-base-content/75">
          <p>
            Log in on the page that opened ({" "}
            <a className="link link-primary" href={started} target="_blank" rel="noopener noreferrer">
              open it again
            </a>
            . If it ends on a page that does not load, paste that page's address here:
          </p>
          <div className="flex gap-2">
            <input className="input input-sm rounded-lg flex-1 font-mono" placeholder="http://127.0.0.1:…/dashboard/oauth/mcp/callback?code=…" /* plain-words-ok: an example of the address to paste */ value={landed} onChange={(event) => setLanded(event.target.value)} />
            <button type="button" className="btn btn-sm rounded-lg gap-1.5" disabled={!landed.trim() || finish.isPending} onClick={() => finish.mutate()}>
              <KeyRound size={14} /> Finish
            </button>
          </div>
        </div>
      )}
      <ErrorNote error={connect.error ?? finish.error ?? logout.error} />
      {dialog}
    </div>
  );
}
