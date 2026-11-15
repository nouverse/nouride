/**
 * An update out for a coding CLI an agent works in, said on Home beside Nouride's own update badge and in its look.
 * Only while there is one, and only to an admin, who is the one that can have it updated: a link to the CLI's card,
 * where the update is asked for. Unlike Nouride's badge it is not there when there is nothing to say: one "up to date"
 * in that corner answers "is it checking", and a second would be noise.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpCircle } from "lucide-react";
import { api } from "@/commons/lib/api";
import { clisToUpdate, cliUpdateWords } from "@/commons/lib/cli-updates";
import { isAdmin, useMe } from "@/commons/lib/session";

export function CliUpdateBadge({ agents }: { agents: readonly { external?: { cli: string } | undefined }[] }) {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  // The server looks at each CLI at most once a minute and asks what is out once a day: ten minutes here is plenty.
  // Asked only where an agent works in a CLI. Who is told is `clisToUpdate`'s to say, in one place.
  const scan = useQuery({ queryKey: ["external-clis"], queryFn: () => api.externalClis(), staleTime: 10 * 60_000, retry: false, enabled: agents.some((agent) => agent.external) });
  const words = cliUpdateWords(clisToUpdate(scan.data?.clis ?? [], agents, admin));
  if (!words) return null;
  return (
    <Link
      to="/models"
      search={{ tab: "clis" }}
      data-cli-update
      className="flex items-center gap-2 rounded-full border border-info/40 bg-info/10 px-3 py-1.5 text-xs font-semibold text-info shadow-xs transition-colors hover:bg-info/15 max-sm:min-h-8"
    >
      <ArrowUpCircle size={13} aria-hidden="true" />
      {words}
    </Link>
  );
}
