/**
 * A conversation on its way: a few bubbles, the person's on the right and the agent's on the left, where its messages
 * will be. Opening a long chat left the page blank until the transcript came.
 */

import { Bone, Loading } from "@/commons/components/ui/Skeleton";
import { cn } from "@/commons/lib/utils";

/** Each bubble: whose side it is on, how wide, how many lines. */
const BUBBLES = [
  { mine: true, width: "w-2/5", lines: 1 },
  { mine: false, width: "w-3/4", lines: 3 },
  { mine: true, width: "w-1/2", lines: 2 },
  { mine: false, width: "w-2/3", lines: 2 },
] as const;

export function ChatLoading() {
  return (
    <Loading className="mx-auto w-full max-w-3xl py-6" inside="space-y-5">
      {BUBBLES.map((bubble, at) => (
        <div key={at} className={cn("flex", bubble.mine && "justify-end")}>
          <div className={cn("space-y-2 rounded-2xl border border-base-content/[0.06] p-4", bubble.width)}>
            {Array.from({ length: bubble.lines }, (_, line) => (
              <Bone key={line} className={line === bubble.lines - 1 && bubble.lines > 1 ? "w-2/3" : "w-full"} />
            ))}
          </div>
        </div>
      ))}
    </Loading>
  );
}
