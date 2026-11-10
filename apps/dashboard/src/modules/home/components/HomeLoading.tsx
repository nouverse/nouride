/**
 * Home on its way: the greeting's card, the cards beside each other under it and the agents' card, where each will
 * be. It stood as a spinner over "Connecting to Nouride…" in the middle of an empty page.
 */

import { Bone, Loading } from "@/commons/components/ui/Skeleton";

export function HomeLoading() {
  return (
    <Loading inside="space-y-6">
      <div className="flex items-center gap-4 rounded-[22px] border border-base-content/[0.06] p-4 sm:gap-6 sm:p-6">
        <Bone className="size-20 shrink-0 rounded-3xl sm:size-28" />
        <div className="min-w-0 flex-1 space-y-3">
          <Bone className="h-7 w-2/3 bg-base-content/10 sm:h-9 sm:w-1/2" />
          <Bone className="w-1/2 sm:w-1/3" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((at) => (
          <div key={at} className="space-y-3 rounded-[22px] border border-base-content/[0.06] p-5">
            <Bone className="h-4 w-1/3 bg-base-content/10" />
            <Bone className="w-4/5" />
            <Bone className="w-1/2" />
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-[22px] border border-base-content/[0.06] p-5">
        <Bone className="h-4 w-1/4 bg-base-content/10" />
        <Bone className="h-24 w-full rounded-2xl" />
      </div>
    </Loading>
  );
}
