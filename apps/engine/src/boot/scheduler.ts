/**
 * The scheduler, built with what its jobs run through: the pipeline for a turn, a command and a delivery, the missions
 * for a mission and its end, and the card a step that waits for a person is asked on.
 *
 * Built once the pipeline exists and started much later (`index.ts`): building it touches nothing.
 */

import type { GlobalConfig } from "@nouride/shared";
import type { AuditPort } from "@/commons/audit.store.ts";
import { localTime } from "@/commons/clock.ts";
import type { Notifier } from "@/commons/notify.ts";
import type { CronPort } from "@/modules/cron/cron.store.ts";
import { CronScheduler, type CronExecutors } from "@/modules/cron/scheduler.ts";
import { StepAsks } from "@/modules/cron/step-asks.ts";
import type { Mission } from "@/modules/missions/types.ts";

export function buildScheduler(params: {
  cron: CronPort;
  /** Read when it is used: the zone and the `[cron]` section a save from the dashboard changes. */
  config: () => GlobalConfig;
  notifier: Pick<Notifier, "ask" | "settle">;
  pipeline: {
    cronExecutors(): CronExecutors;
    voiceGatewayId(agentId: string, gatewayId: string): string;
    isAdmin(who: { gatewayId: string; senderId: string }): boolean;
  };
  missions: {
    runJob: NonNullable<CronExecutors["startMission"]>;
    endOf: NonNullable<CronExecutors["missionEnd"]>;
    watch(watcher: (mission: Mission) => void): void;
  };
  audit?: AuditPort;
}): { scheduler: CronScheduler; stepAsks: StepAsks } {
  const { pipeline, missions } = params;
  // A step that waits for a person: its card where the job reports, and a press on it. The run is the scheduler's.
  const stepAsks: StepAsks = new StepAsks({
    store: params.cron,
    notifier: params.notifier,
    voice: (agentId, gatewayId) => pipeline.voiceGatewayId(agentId, gatewayId),
    isAdmin: (who) => pipeline.isAdmin(who),
    answer: (runId, go, by, via) => scheduler.answerRun(runId, go, by, via),
    when: (at) => {
      const local = localTime(at, params.config().daemon.timezone);
      return `${local.day} ${local.time}`;
    },
  });
  const scheduler: CronScheduler = new CronScheduler({
    store: params.cron,
    config: params.config().cron,
    // A `mission` job's run starts a mission, and a step that is one waits for it; the rest run through the pipeline.
    executors: {
      ...pipeline.cronExecutors(),
      startMission: missions.runJob,
      missionEnd: missions.endOf,
      ask: (job, runId, step, shown, until) => stepAsks.ask(job, runId, step, shown, until),
      settleAsk: (card, text) => stepAsks.settled(card, text),
    },
    ...(params.audit ? { audit: params.audit } : {}),
  });
  missions.watch((mission) => scheduler.missionChanged(mission.id));
  return { scheduler, stepAsks };
}
