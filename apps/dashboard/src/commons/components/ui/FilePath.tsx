/**
 * A path that is a file of this machine's data folder, drawn as a link to it in System's Files; any other text is
 * drawn as it was. For an admin: nobody else is told where the folder is, so for them nothing here is a link.
 *
 * `FilePath` is one piece of text taken whole (a span of code, a file's name on a mission's page). `PathWords` is a
 * line of several (a command a turn ran): each word that is such a path becomes its link, the rest stays text.
 */

import { useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useDataFolder } from "@/commons/hooks/use-data-folder";
import { underDataFolder } from "@/commons/lib/data-folder";

function ToFile({ path, className, children }: { path: string; className?: string; children: ReactNode }) {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  if (!router) return <>{children}</>;
  const page = `/files?path=${encodeURIComponent(path)}`;
  return (
    <a
      href={`${router.basepath.replace(/\/+$/, "")}${page}`}
      title="Open in Files"
      className={className}
      onClick={(event) => {
        // A plain click only: with a key held, or another button, the browser opens it its own way (a new tab).
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void router.navigate({ href: page });
      }}
    >
      {children}
    </a>
  );
}

/** `text` whole: a link where it names a file of the data folder (`link` is its look), `children` or the text as it is otherwise. */
export function FilePath({ text, link, children }: { text: string; link: string; children?: ReactNode }) {
  const path = underDataFolder(text, useDataFolder());
  if (path === null) return <>{children ?? text}</>;
  return (
    <ToFile path={path} className={link}>
      {children ?? text}
    </ToFile>
  );
}

/** A line of words: each that names a file of the data folder a link to it, everything else as written. */
export function PathWords({ text, link }: { text: string; link: string }) {
  const folder = useDataFolder();
  if (!folder || !(text.includes(".nouride/") || text.includes(folder))) return <>{text}</>;
  return (
    <>
      {text.split(/(\s+)/).map((word, index) => {
        // A word in quotes is the path inside them.
        const bare = word.replace(/^["'`(]+/, "");
        const path = underDataFolder(bare, folder);
        if (path === null) return word;
        return (
          <span key={index}>
            {word.slice(0, word.length - bare.length)}
            <ToFile path={path} className={link}>
              {bare}
            </ToFile>
          </span>
        );
      })}
    </>
  );
}
