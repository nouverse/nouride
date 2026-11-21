/**
 * After an import: what came, what did not, and what to do next. Until "Go live" nothing of this Nouride reaches a chat
 * app and no automation runs: the old machine may still be doing both, and two machines on one bot get in each other's
 * way. Once live, the note stays until it is put away, with where what was here before is kept.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Rocket } from "lucide-react";
import type { ImportReport } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { restartThrough } from "@/commons/lib/restart";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { count, holdsLines, waitingLine } from "@/commons/lib/transfer-words";

/** What did not come with the file, a line each: what the person does about it is in the line. */
export function didNotCome(report: ImportReport): string[] {
  return [
    "The sign-ins of coding CLIs: sign each one in again on its agent's page",
    ...(report.secrets === null ? ["Secrets: the file held none, so each is entered again on Secrets"] : []),
    ...(report.folders ? [] : ["The agents' own folders: the file was made without them"]),
    "A chat app's own session, such as a linked WhatsApp: link it again on Connections",
    "Backups, logs and installed tools: these are made again here",
    ...(report.passed.links + report.passed.credentials > 0 ? [`${count(report.passed.links + report.passed.credentials, "file")} in the agents' folders that were links, or held a sign-in or a key`] : []),
  ];
}

export function ImportedCard({ report, restarts }: { report: ImportReport; restarts: boolean }) {
  const queryClient = useQueryClient();
  const live = useMutation({
    mutationFn: async () => {
      let needsRestart = false;
      await restartThrough(async () => {
        const done = await api.goLive();
        needsRestart = done.restart && !done.restarting;
        return done.restarting ? { waiting: false, note: "" } : null;
      });
      await queryClient.invalidateQueries();
      return needsRestart;
    },
  });
  const away = useMutation({ mutationFn: api.putImportAway, onSuccess: (next) => queryClient.setQueryData(["transfer"], next) });
  return (
    <Card
      title={report.live ? "This Nouride was brought in from another machine" : "Brought in, and not live yet"}
      description={`From Nouride ${report.from.version}, on ${new Date(report.at).toLocaleString()}.`}
    >
      <div className="space-y-4 text-sm" data-imported={report.live ? "live" : "held"}>
        {!report.live ? (
          <div className="space-y-3 rounded-2xl bg-warning/10 p-4" data-go-live>
            <p className="font-semibold text-base-content">{waitingLine(report.held)}</p>
            <p className="text-base-content/80">
              Switch the old machine off first. Two machines answering the same chat app get in each other's way, and an automation would run on both.
              {report.held.missions > 0 ? ` ${count(report.held.missions, "mission")} that ${report.held.missions === 1 ? "was" : "were"} at work ${report.held.missions === 1 ? "is" : "are"} paused: resume ${report.held.missions === 1 ? "it" : "them"} on Work when you are ready.` : ""}
            </p>
            <button type="button" className="btn btn-primary btn-sm gap-2 rounded-xl" disabled={live.isPending} onClick={() => live.mutate()}>
              <Rocket size={14} aria-hidden="true" /> Go live
            </button>
            <ErrorNote error={live.error} />
          </div>
        ) : (
          <p className="flex items-start gap-2 text-base-content/80" data-is-live>
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
            <span>{live.data ? `It is live. ${restarts ? "" : "Restart Nouride to bring its connections to chat apps back: nothing on this server starts it again by itself."}` : "It is live: its connections and automations are on."}</span>
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="font-semibold text-base-content">What came</p>
            <ul className="list-disc space-y-1 pl-5 text-base-content/80" data-came>
              <li>{report.agents.length > 0 ? `${count(report.agents.length, "agent")}: ${report.agents.join(", ")}` : "No agents"}</li>
              {holdsLines(report.parts, 0)
                .slice(1)
                .map((line) => (
                  <li key={line}>{line}</li>
                ))}
              <li>Every chat, memory, mission, automation and account</li>
              {report.secrets !== null ? <li>{count(report.secrets, "secret")}, kept encrypted on this machine</li> : null}
            </ul>
          </div>
          <div className="space-y-2">
            <p className="font-semibold text-base-content">What did not</p>
            <ul className="list-disc space-y-1 pl-5 text-base-content/80" data-did-not-come>
              {didNotCome(report).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>

        {report.missing.length > 0 ? (
          <div className="space-y-2" data-missing>
            <p className="font-semibold text-base-content">Places the settings name that are not on this machine</p>
            <ul className="list-disc space-y-1 pl-5 text-base-content/80">
              {report.missing.map((one) => (
                <li key={`${one.setting}:${one.path}`}>
                  <span className="font-mono text-[13px]">{one.path}</span> <span className="text-base-content/65">({one.setting})</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-xs text-base-content/65">
          Everyone signs in again with the other machine's accounts: {count(report.ended.sessions, "sign-in")} and {count(report.ended.devices, "device")} were ended. What this Nouride held before is kept on this machine, in <span className="font-mono">{report.kept}</span>: whoever runs the server can remove it once you are satisfied.
        </p>
        {report.live ? (
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" disabled={away.isPending} onClick={() => away.mutate()}>
            Put this note away
          </button>
        ) : null}
        <ErrorNote error={away.error} />
      </div>
    </Card>
  );
}
