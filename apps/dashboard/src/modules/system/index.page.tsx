/**
 * System → System: what this machine is using, for whoever runs it.
 *
 * Until now the daemon's memory was a number in `/health` and the disk a line in `nouride doctor`: a box that was
 * slow or full was found out over SSH. Three cards, each a bar with a sentence: the RAM Nouride may use and who holds
 * it, the disk the data folder is on and what in that folder is large, and Nouride as it runs here. Read while the page is
 * open, every few seconds, and not otherwise.
 */

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Cpu, File, Folder, HardDrive, MemoryStick } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "@/commons/lib/api";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";
import { Card, EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { CardLoading } from "@/commons/components/ui/Skeleton";
import { CopyButton } from "@/commons/components/ui/CopyButton";
import { ago, formatBytes } from "@/commons/lib/format";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Meter } from "./components/Meter";
import { ceilingWords, commandsWords, inUseWords, shareOf, upFor } from "./lib/words";

/** A line of a card: what it is, and its figure. */
function Row({ icon, name, children }: { icon?: ReactNode; name: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t border-base-content/[0.06] py-2 text-sm first:border-t-0">
      <span className="flex items-center gap-2 text-base-content/65">
        {icon}
        {name}
      </span>
      <span className="min-w-0 text-right font-medium text-base-content/85 [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

/** The data folder's own entries, largest first, each a way into Files. */
function FolderSizes() {
  const sizes = useQuery({
    queryKey: ["system", "folder-sizes"],
    queryFn: api.systemFolderSizes,
    // Asked again soon while the count runs, and now and then once it is in.
    refetchInterval: (query) => (query.state.data?.state === "measuring" ? 2_000 : 60_000),
    retry: false,
  });
  const read = sizes.data;
  if (!read || (read.state === "measuring" && read.totalBytes === null)) {
    return <p className="border-t border-base-content/[0.06] pt-3 text-sm text-base-content/65">Counting how much Nouride's own files take. On a large folder this is a minute or so.</p>;
  }
  if (read.totalBytes === null) {
    return <p className="border-t border-base-content/[0.06] pt-3 text-sm text-base-content/65">How much Nouride's own files take could not be counted here.</p>;
  }
  const largest = read.entries.slice(0, 6);
  const top = largest[0]?.bytes ?? 0;
  return (
    <div className="space-y-2 border-t border-base-content/[0.06] pt-3">
      <p className="text-sm text-base-content/85">
        <span className="font-semibold">Nouride's own files take {formatBytes(read.totalBytes)}.</span>{" "}
        <span className="text-base-content/65">{read.measuredAt ? `Counted ${ago(read.measuredAt)}${read.state === "measuring" ? ", and being counted again" : ""}.` : null}</span>
      </p>
      <ul className="space-y-1.5">
        {largest.map((entry) => (
          <li key={entry.name}>
            <Link to="/files" search={{ path: entry.name }} className="group flex items-center gap-3 rounded-lg px-1 py-1 text-sm outline-none hover:bg-base-200/60 focus-visible:ring-2 focus-visible:ring-primary/50">
              {entry.kind === "folder" ? <Folder size={14} className="shrink-0 text-base-content/50" aria-hidden="true" /> : <File size={14} className="shrink-0 text-base-content/50" aria-hidden="true" />}
              <span className="w-28 shrink-0 truncate font-mono text-xs text-base-content/85 group-hover:text-primary sm:w-36">{entry.name}</span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-base-content/[0.08]" aria-hidden="true">
                <span className="block h-full rounded-full bg-secondary/60" style={{ width: `${top > 0 ? Math.max((entry.bytes / top) * 100, 1.5) : 0}%` }} />
              </span>
              <span className="w-20 shrink-0 text-right text-xs text-base-content/65">{formatBytes(entry.bytes)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SystemPage() {
  const admin = isAdmin(useMe().data ?? null);
  const system = useQuery({ queryKey: ["system"], queryFn: api.system, refetchInterval: 5_000, retry: false, enabled: admin });

  if (!admin) {
    return (
      <div className="space-y-6">
        <PageHeader title="System" />
        <Card>
          <EmptyState pose="searching" title="For an admin" description="What this machine is using and the files Nouride keeps are an admin's to look at." />
        </Card>
      </div>
    );
  }

  const read = system.data;
  const memory = read?.memory;
  const disk = read?.disk ?? null;
  const diskUsed = disk ? disk.totalBytes - disk.freeBytes : null;

  return (
    <div className="space-y-6">
      <PageHeader ask={PAGE_ASKS.system} title="System" description="What this machine is using right now, and what Nouride keeps on it." />
      {system.error && !read ? (
        <Card>
          <ErrorNote error={system.error} />
        </Card>
      ) : !read || !memory ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CardLoading lines={4} />
          <CardLoading lines={4} />
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <Card title="RAM" description="The working memory Nouride and its agents' commands share.">
            <div className="space-y-3">
              <Meter share={shareOf(memory.usedBytes, memory.totalBytes)} label="RAM in use" words={inUseWords(memory.usedBytes, memory.totalBytes)} />
              {ceilingWords(memory) ? <p className="text-sm text-base-content/65">{ceilingWords(memory)}</p> : null}
              <div>
                <Row icon={<MemoryStick size={14} aria-hidden="true" />} name="Nouride itself">
                  {formatBytes(memory.daemonBytes)}
                </Row>
                <Row icon={<MemoryStick size={14} aria-hidden="true" />} name="The agents' commands">
                  {commandsWords(memory.commands)}
                </Row>
              </div>
            </div>
          </Card>

          <Card title="Disk" description="The disk Nouride's files are on.">
            <div className="space-y-3">
              {disk && diskUsed !== null ? (
                <>
                  <Meter share={shareOf(diskUsed, disk.totalBytes)} label="Disk in use" words={`${formatBytes(diskUsed)} of ${formatBytes(disk.totalBytes)} in use`} />
                  <p className="text-sm text-base-content/65">{formatBytes(disk.freeBytes)} is free.</p>
                </>
              ) : (
                <p className="text-sm text-base-content/65">Nouride cannot tell how large the disk is here.</p>
              )}
              <FolderSizes />
            </div>
          </Card>

          <Card title="Nouride here" className="lg:col-span-2">
            <Row icon={<HardDrive size={14} aria-hidden="true" />} name="Version">
              {read.version}
            </Row>
            <Row icon={<HardDrive size={14} aria-hidden="true" />} name="Running for">
              {upFor(read.uptimeSeconds)}
            </Row>
            <Row icon={<Cpu size={14} aria-hidden="true" />} name="Processor cores it may use">
              {read.cores}
            </Row>
            <Row icon={<Folder size={14} aria-hidden="true" />} name="Where its files are">
              <span className="inline-flex max-w-full items-center gap-1">
                <Link to="/files" search={{ path: "" }} className="min-w-0 font-mono text-xs text-primary hover:underline [overflow-wrap:anywhere]">
                  {read.folder}
                </Link>
                <CopyButton text={read.folder} />
              </span>
            </Row>
          </Card>
        </div>
      )}
    </div>
  );
}
