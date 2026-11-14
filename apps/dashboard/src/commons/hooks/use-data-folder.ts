/**
 * Where this machine's data folder is, for an admin: what a path is held against to know it is a file System's Files
 * can open (`commons/lib/data-folder.ts`). Null for anyone else, and until the daemon has said: Files is an admin's,
 * so a link to it would open on a refusal for them.
 *
 * Null too where nothing provides the app's queries: the markdown that asks is also drawn on its own (a preview, a
 * test), where a path is no link to anything, as a page's address is not there either.
 */

import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { isAdmin } from "@/commons/lib/session";

/** Stands in where no client is provided, so the hooks below are called all the same; it is never asked anything. */
const NOWHERE = new QueryClient();

export function useDataFolder(): string | null {
  const provided = useContext(QueryClientContext);
  const client = provided ?? NOWHERE;
  // Who is signed in, as the shell already keeps it: read here, never asked for again.
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: false }, client);
  const admin = provided !== undefined && isAdmin(me.data ?? null);
  // Asked once: the folder does not move while the daemon runs.
  const system = useQuery({ queryKey: ["system", "folder"], queryFn: api.system, enabled: admin, staleTime: Infinity, retry: false }, client);
  return admin ? (system.data?.folder ?? null) : null;
}
