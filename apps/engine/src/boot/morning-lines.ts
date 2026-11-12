/**
 * The morning lines (0.8.0, `modules/people/morning-line.ts`), wired to what the daemon keeps: the runs that failed, the
 * approvals and missions waiting, the missions that ended, the day's spend — each narrowed to the person, or all of it
 * for an admin — and sent to the person's own chat, by the orchestrator: the account they picked, else the one they last
 * wrote from, else the next of theirs whose connection is up.
 */

import type { Gateway, GlobalConfig, Person } from "@nouride/shared";
import type { Notifier } from "@/commons/notify.ts";
import { morningLinesState } from "@/commons/daemon-state.ts";
import type { StateRows } from "@/commons/daemon-state.store.ts";
import type { CronPort } from "@/modules/cron/cron.store.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import type { MissionsPort } from "@/modules/missions/missions.store.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { personIdMatches } from "@/modules/people/match.ts";
import { startMorningLines, type MorningFacts } from "@/modules/people/morning-line.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import type { ApprovalGate } from "@/modules/tools/approval.ts";

/** A person's accounts as platform and account: `telegram:555` is 555 on every Telegram connection. */
export function accountsOf(person: Person): { platform: string; account: string }[] {
  return (person.ids ?? []).flatMap((id) => {
    const at = id.indexOf(":");
    return at > 0 ? [{ platform: id.slice(0, at), account: id.slice(at + 1) }] : [];
  });
}

/**
 * The accounts a morning line tries, in turn (0.8.0): the one they picked (`morning_to`), then the one they last wrote
 * from, then the rest of their chat accounts — never a dashboard one, which no message reaches. It went to the first
 * account in their list before, which on the live box was a Discord its owner did not read in the morning.
 */
export function morningRoute(person: Person, lastFrom: readonly { gatewayId: string; senderId: string }[]): { platform: string; account: string }[] {
  const chats = accountsOf(person).filter((one) => one.platform !== "web");
  const idOf = (one: { platform: string; account: string }) => `${one.platform}:${one.account}`;
  const picked = chats.filter((one) => idOf(one) === person.morningTo);
  const recent = lastFrom.map((turn) => chats.find((one) => personIdMatches(idOf(one), turn))).find((one) => one !== undefined);
  return [...new Map([...picked, ...(recent ? [recent] : []), ...chats].map((one) => [idOf(one), one])).values()];
}

/** What the daemon keeps that a morning line reads. */
export interface MorningSources {
  cron: Pick<CronPort, "recentRuns" | "get" | "waitingRuns">;
  missions: Pick<MissionsPort, "open" | "endedBetween"> | undefined;
  approvals: () => Pick<ApprovalGate, "pending">;
  usage: Pick<UsagePort, "since" | "spenders">;
  now?: () => number;
}

/** What happened since `from` that is this person's — their chats, their runs, their missions — or all of it for an admin. */
export function morningFacts(params: MorningSources): (person: Person, from: number, admin: boolean) => MorningFacts {
  const theirs = (person: Person) => {
    const accounts = accountsOf(person).filter((one) => one.platform !== "web").map((one) => one.account);
    return { chat: (chatId: string) => accounts.includes(chatId), sender: (senderId: string) => accounts.includes(senderId) };
  };

  return (person: Person, from: number, admin: boolean): MorningFacts => {
    const mine = theirs(person);
    const now = (params.now ?? Date.now)();
    const missionOf = (id: string) => params.missions?.open().find((mission) => mission.id === id);
    const failed = params.cron
      .recentRuns(500)
      .filter((run) => run.status === "error" && run.startedAt >= from)
      .filter((run) => {
        if (admin) return true;
        const job = params.cron.get(run.jobId);
        return job !== null && (mine.chat(job.target.chatId) || (job.turnedOnBy !== undefined && mine.sender(job.turnedOnBy)));
      })
      .map((run) => ({ job: run.jobName, why: run.result ?? "failed" }));
    const approvals = params
      .approvals()
      .pending()
      .filter((request) => admin || mine.chat(request.chatId) || (String(request.gateway) === MISSION_GATEWAY_ID && mine.sender(missionOf(request.chatId)?.startedBy ?? "")))
      .map((request) => ({ agent: request.agentId, what: request.tool }));
    const missionIsMine = (mission: { startedBy: string; chatId: string }) => admin || mine.sender(mission.startedBy) || mine.chat(mission.chatId);
    // A step of a job that waits for a person's yes is theirs as its failed run would be: by its chat, or who turned it on.
    const steps = params.cron.waitingRuns().flatMap(({ run, state }) => {
      const job = state.wait.kind === "approval" ? params.cron.get(run.jobId) : null;
      if (!job || state.wait.kind !== "approval") return [];
      const theirOwn = admin || mine.chat(job.target.chatId) || (job.turnedOnBy !== undefined && mine.sender(job.turnedOnBy));
      return theirOwn ? [{ goal: job.name, what: state.wait.ask }] : [];
    });
    const needsYou = [
      ...(params.missions?.open() ?? [])
        .filter((mission) => mission.status === "waiting" && missionIsMine(mission))
        .map((mission) => ({ goal: mission.goal, what: mission.reason ?? mission.waitKind ?? "waiting" })),
      ...steps,
    ];
    const ended = (params.missions?.endedBetween(from, now) ?? [])
      .filter(missionIsMine)
      .map((mission) => ({ goal: mission.goal, status: mission.status as "done" | "failed" | "stopped", ...(mission.status !== "done" && mission.reason ? { why: mission.reason } : {}) }));
    const spent = admin ? params.usage.since(from) : undefined;
    // Dollars when every request had a price, tokens otherwise: a total missing some is not a total. The biggest three
    // by whichever it says — the store orders by dollars, and an unpriced model's are all zero.
    const priced = spent !== undefined && spent.unpricedRequests === 0;
    const top = admin
      ? params.usage
          .spenders(from, 50)
          .sort((a, b) => (priced ? b.usd - a.usd : b.tokens - a.tokens))
          .slice(0, 3)
          .map((one) => ({ agent: one.agentId, model: one.model, usd: one.usd, tokens: one.tokens }))
      : [];
    return {
      failed,
      approvals,
      needsYou,
      ended,
      ...(spent
        ? {
            spent: { usd: priced ? spent.usd : null, tokens: spent.inputTokens + spent.outputTokens, top },
          }
        : {}),
    };
  };
}

export function startMorning(params: MorningSources & {
  config: () => GlobalConfig;
  gateways: Map<string, Gateway>;
  notifier: Pick<Notifier, "toChat">;
  /** Where each of a person's accounts last wrote from — the line's way to them when they picked none. */
  turns: Pick<TurnsPort, "lastFrom">;
  /** The pipeline's: who an admin is, and the connection an agent speaks on. */
  pipeline: () => { isAdmin(who: { gatewayId: string; senderId: string }): boolean; voiceGatewayId(agentId: string, gatewayId: string): string };
  /** Where the day each person's line last came is kept (`daemon_state`). */
  state: StateRows;
}): ReturnType<typeof setInterval> {
  const send = async (person: Person, text: string): Promise<boolean> => {
    const config = params.config();
    const by = config.daemon.orchestrator ?? "";
    const lastFrom = params.turns.lastFrom(accountsOf(person).map((one) => one.account));
    for (const { platform, account } of morningRoute(person, lastFrom)) {
      const gateway = [...params.gateways.values()].find((one) => one.platform === platform && one.status === "connected");
      if (!gateway) continue;
      const voice = by ? params.pipeline().voiceGatewayId(by, gateway.id) : gateway.id;
      if (await params.notifier.toChat({ gatewayId: voice, chatId: account }, text)) return true;
    }
    return false;
  };

  return startMorningLines({
    people: () => params.config().people,
    timezone: () => params.config().daemon.timezone,
    isAdmin: (person) => accountsOf(person).some((one) => one.platform === "web" && params.pipeline().isAdmin({ gatewayId: "web:dashboard", senderId: one.account })),
    facts: morningFacts(params),
    send,
    said: morningLinesState(params.state),
  });
}
