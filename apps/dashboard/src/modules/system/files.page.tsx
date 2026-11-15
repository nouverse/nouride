/**
 * System → Files: what Nouride keeps on this machine, to look at, keep a copy of, and clear of what agents and chats
 * left behind.
 *
 * One column at every width: where you are, then either that folder's entries or the one file its path names. The
 * path is in the address (`?path=`), so a folder or a file has a link, the browser's Back goes back a folder, and a
 * path an agent wrote in a chat opens here on the file it names.
 *
 * From a laptop's width up the page is held to the window (`fillsViewport`): its title, its tabs and where you are
 * stay, and the list or the file scrolls inside the card. A folder of five hundred entries was a page five hundred
 * rows long, with the way back to its folder scrolled away. On a phone it scrolls as a document, as every page does.
 */

import { PAGE_ASKS } from "@/commons/components/agents/page-asks";
import { FilesBrowser } from "@/commons/components/files/FilesBrowser";
import { Card, EmptyState, PageHeader } from "@/commons/components/ui/ui";
import { FILL_PAGE } from "@/commons/components/ui/ScrollCard";
import { isAdmin, useMe } from "@/commons/lib/session";

export default function FilesPage({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const admin = isAdmin(useMe().data ?? null);
  if (!admin) {
    return (
      <div className="space-y-6">
        <PageHeader title="Files" />
        <Card>
          <EmptyState pose="searching" title="For an admin" description="The files Nouride keeps are an admin's to look at." />
        </Card>
      </div>
    );
  }
  return (
    <div className={FILL_PAGE}>
      <PageHeader ask={PAGE_ASKS.files} title="Files" description="What Nouride keeps on this machine. What agents and chats left behind can be deleted here; the rest is to look at." />
      <Card className="lg:flex lg:min-h-[22rem] lg:flex-1 lg:flex-col" bodyClassName="lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        <FilesBrowser path={path} onOpen={onOpen} />
      </Card>
    </div>
  );
}
