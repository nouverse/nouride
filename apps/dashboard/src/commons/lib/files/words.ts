/**
 * What a files view says of a delete, wherever files are shown: System's Files and the Workspace views.
 */

import type { SystemFileWeight } from "@nouride/wire";
import { formatBytes } from "@/commons/lib/format";

/**
 * What the question before a delete says it would take: a file's size, a folder's files and what they take on disk.
 * A count that stopped at its ceiling is "more than", and a size that could not be measured is left unsaid. A link
 * is listed as the folder or file it leads to, so its question says that only the link goes.
 */
export function deleteWords(weight: SystemFileWeight): string {
  if (weight.link) return "It is a link: the link will be gone from this machine, and what it leads to stays.";
  if (weight.entry.kind === "file") return weight.bytes === null ? "It will be gone from this machine." : `It is ${formatBytes(weight.bytes)}, and will be gone from this machine.`;
  if (weight.files === 0 && !weight.more) return "The folder is empty, and will be gone from this machine.";
  const files = `${weight.more ? "more than " : ""}${weight.files.toLocaleString("en")} ${weight.files === 1 && !weight.more ? "file" : "files"}`;
  return `The folder and everything in it will be gone from this machine: ${files}${weight.bytes === null ? "" : `, ${formatBytes(weight.bytes)}`}.`;
}
