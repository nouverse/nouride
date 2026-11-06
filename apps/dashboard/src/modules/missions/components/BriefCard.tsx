/**
 * A mission's brief (0.8.11): its own folder's `BRIEF.md`, or the file its goal names, on its page — folded to its
 * header until opened, as the owner asked, and opened whole by its file's name as its report is (`MissionResult`),
 * folded or not.
 */

import { useState } from "react";
import { FileText } from "lucide-react";
import { Card } from "@/commons/components/ui/ui";
import { Markdown } from "@/commons/components/ui/Markdown";
import { MarkdownPreview } from "@/commons/components/ui/MarkdownPreview";

export function BriefCard({ brief, shown }: { brief: string; shown: { name: string; said: string } }) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  return (
    <>
      <Card
        title="Brief"
        description={shown.said}
        folded={{ open, toggle: () => setOpen((was) => !was) }}
        actions={
          <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg font-mono" onClick={() => setReading(true)}>
            <FileText size={12} aria-hidden="true" /> Read it whole
          </button>
        }
      >
        <div className="max-h-96 overflow-y-auto pr-1 [overflow-wrap:anywhere]">
          <Markdown source={brief} compact />
        </div>
      </Card>
      {/* Outside the card's body: folded, the body is not there, and the file still opens from the header. */}
      {reading && <MarkdownPreview name={shown.name} source={brief} onClose={() => setReading(false)} />}
    </>
  );
}
