/**
 * "Download all": the files of one reply fetched as the page would fetch them to show them, written into one `.zip`
 * in the browser (`zip.ts`), and saved under one name. The daemon serves each file as it does today and carries
 * nothing new.
 */

import { zipParts, type ZipFile } from "@/commons/lib/zip";

export interface SetFile {
  name: string;
  url: string;
}

/**
 * What the archive is called: the stem the set's names share ("slide-01.png", "slide-02.png" -> "slide.zip"), or
 * "files.zip" when they share fewer than three letters.
 */
export function archiveName(names: string[]): string {
  const stems = names.map((name) => name.replace(/\.[^.]+$/, ""));
  let shared = stems[0] ?? "";
  for (const stem of stems.slice(1)) {
    let n = 0;
    while (n < shared.length && shared[n] === stem[n]) n++;
    shared = shared.slice(0, n);
  }
  // What a numbered set leaves after its shared part: "slide-0" of "slide-01" and "slide-02".
  const stem = shared.replace(/[^\p{L}\p{N}]*\d*[^\p{L}\p{N}]*$/u, "");
  return stem.length >= 3 ? `${stem}.zip` : "files.zip";
}

/** The set as one archive, each file fetched in turn; `progress` hears how many are in. A file that cannot be had stops it, named. */
export async function archiveOf(files: SetFile[], progress?: (done: number) => void, get: typeof fetch = fetch): Promise<Blob> {
  const read: ZipFile[] = [];
  for (const file of files) {
    let response: Response;
    try {
      response = await get(file.url, { credentials: "same-origin" });
    } catch {
      throw new Error(`${file.name} could not be fetched`);
    }
    if (!response.ok) throw new Error(`${file.name} could not be fetched (error ${response.status})`);
    const modified = response.headers.get("last-modified");
    read.push({ name: file.name, bytes: new Uint8Array(await response.arrayBuffer()), ...(modified && !Number.isNaN(Date.parse(modified)) ? { modified: new Date(modified) } : {}) });
    progress?.(read.length);
  }
  return new Blob(zipParts(read) as BlobPart[], { type: "application/zip" });
}

/** Hand a blob to the browser as a download of that name. */
export function saveAs(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download has its bytes once it starts; a minute is long past that.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
