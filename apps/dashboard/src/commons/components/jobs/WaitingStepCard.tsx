/**
 * A step of an automation that waits for a person, as a card among what waits for you (Work's first tab, Home): whose
 * automation it is, the question with its two answers, and the way to the automation's own page.
 */

import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { WaitingStep } from "@nouride/wire";
import { Tag } from "@/commons/components/ui/Tag";
import { StepQuestion } from "./WaitingStep";

export function WaitingStepCard({ step, agent, canAnswer }: { step: WaitingStep; agent: string; canAnswer: boolean }) {
  return (
    <div className="flex w-full flex-col gap-3 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft sm:p-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="needs">Needs you</Tag>
        <Tag>
          {step.jobName} · {agent}
        </Tag>
      </div>
      <StepQuestion runId={step.runId} name={step.jobName} ask={step.ask} said={step.said} until={step.until} canAnswer={canAnswer} />
      <Link to="/automations/$id" params={{ id: step.jobId }} className="group flex items-center gap-1.5 self-start text-sm text-base-content/70 hover:text-base-content">
        Open the automation
        <ArrowRight size={14} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}
