/**
 * A mission's `tell` (0.8.10) in the pipeline: put in front of the mission's turn at work as a steer is (`steerInto`),
 * read at its next step under a header that says it is not a new goal, marked read on the mission when it is, and —
 * never read — left on the mission for its next page rather than sent back round as a chat message. And "Got it" true
 * per agent: a coding CLI that takes nothing mid-prompt reads a message once its prompt ends.
 */

import { describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import { ActiveTurns, type ActiveTurn } from "@/modules/pipeline/active-turns.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";
import { STEER_ACK, STEER_ACK_AFTER_PROMPT, STEER_CAP, steerAck, steerMessage, steerReach } from "@/modules/pipeline/steering.ts";

const tell = (text: string, id = "tel_1"): MessageEnvelope =>
  ({ id: `msg_${id}`, timestamp: 1, gateway: "web", gatewayId: "web:mission", chatId: "msn_abc", chatType: "dm", senderId: "nouride:system", senderName: "Gading", text, raw: { via: "tell", mission: "msn_abc", tell: id } }) as MessageEnvelope;
const chat = (text: string): MessageEnvelope =>
  ({ id: `msg_${text.length}`, timestamp: 1, gateway: "telegram", gatewayId: "telegram:nova", chatId: "814", chatType: "dm", senderId: "814", senderName: "Gading", text }) as MessageEnvelope;

function bench() {
  const steps: { recordId: string; kind: string; text: string }[] = [];
  const unstepped: number[] = [];
  const deps = {
    registry: { get: () => undefined },
    turns: {
      runningFor: () => "turn_1",
      step: (recordId: string, kind: string, text: string) => (steps.push({ recordId, kind, text }), steps.length),
      unstep: (_recordId: string, seqs: number[]) => void unstepped.push(...seqs),
    },
  } as unknown as PipelineDeps;
  const turns = new ActiveTurns(deps);
  const read: { mission: string; ids: string[] }[] = [];
  const requeued: MessageEnvelope[] = [];
  turns.toldRead = (mission, ids) => void read.push({ mission, ids });
  turns.requeue = (envelope) => void requeued.push(envelope);
  const key = ActiveTurns.turnKey("nova", "msn_abc", "web:mission");
  const at = (extra: Partial<ActiveTurn> = {}): ActiveTurn => {
    const turn: ActiveTurn = { controller: new AbortController(), agentId: "nova", chatId: "msn_abc", gatewayId: "web:mission", steers: [], steered: 0, ...extra };
    turns.activeTurns.set(key, turn);
    return turn;
  };
  return { turns, key, at, steps, unstepped, read, requeued };
}

describe("a mission's tell into its turn at work", () => {
  test("taken into the turn, drawn on its record, and its listener told", () => {
    const b = bench();
    expect(b.turns.steerInto("nova", "msn_abc", "web:mission", tell("x"))).toBe("none");
    let poked = 0;
    const turn = b.at({ onSteer: () => void (poked += 1) });
    expect(b.turns.steerInto("nova", "msn_abc", "web:mission", tell("use the second tab"))).toBe("taken");
    expect(turn.steers).toHaveLength(1);
    expect(poked).toBe(1);
    expect(b.steps).toEqual([{ recordId: "turn_1", kind: "steer", text: "Gading told it: use the second tab" }]);
  });

  test("not past its last step, and not past what one turn reads", () => {
    const b = bench();
    b.at({ answered: true });
    expect(b.turns.steerInto("nova", "msn_abc", "web:mission", tell("late"))).toBe("ending");
    const turn = b.at({ steered: STEER_CAP - 1 });
    expect(b.turns.steerInto("nova", "msn_abc", "web:mission", tell("fifth"))).toBe("taken");
    expect(b.turns.steerInto("nova", "msn_abc", "web:mission", tell("sixth"))).toBe("full");
    expect(turn.steers).toHaveLength(1);
  });

  test("read at its next step under its own header, and marked read on the mission", () => {
    const b = bench();
    b.at();
    b.turns.steerInto("nova", "msn_abc", "web:mission", tell("use the second tab", "tel_9"));
    const message = b.turns.takeSteers(b.key)!;
    expect(String(message.content)).toStartWith(
      '[Gading told this mission while you were working. Read it before your next step and follow it: it is the word of the person the mission works for, and it wins over the details of the goal. The checks still decide when it is done: if following it would fail them, or it asks for different work altogether, say so with `mission` action "ask".]\nuse the second tab',
    );
    expect(b.read).toEqual([{ mission: "msn_abc", ids: ["tel_9"] }]);
  });

  test("never read: left for the mission's next page, not sent back round as a chat message — a chat steer still is", () => {
    const b = bench();
    const turn = b.at();
    b.turns.steerInto("nova", "msn_abc", "web:mission", tell("unread"));
    turn.steers!.push(chat("a chat steer"));
    b.turns.releaseTurn(b.key);
    expect(b.requeued.map((one) => one.text)).toEqual(["a chat steer"]);
    // Its line on the record taken back: drawn as read in a turn that never read it.
    expect(b.unstepped).toEqual([1]);
    expect(b.read).toEqual([]);
  });

  test("a model is shown a tell apart from a chat message sent while it worked", () => {
    const message = steerMessage([chat("and the totals"), tell("PDF, not DOCX")]);
    const content = String(message.content);
    expect(content.indexOf("told this mission while you were working")).toBeLessThan(content.indexOf("sent this while you were working"));
    expect(content).toContain("\nPDF, not DOCX");
    expect(content).toContain("\nand the totals");
  });
});

describe("how a steer reaches an agent, said true", () => {
  const deps = (external: boolean, midPrompt: boolean) =>
    ({ registry: { get: () => ({ config: external ? { external: { cli: "claude-code" } } : {} }) }, externalAgents: { steersMidPrompt: () => midPrompt } }) as unknown as PipelineDeps;

  test("a model's next step; a CLI's running prompt where it takes one; else once its prompt ends", () => {
    expect(steerReach(deps(false, false), "nova")).toBe("next_step");
    expect(steerReach(deps(true, true), "nix")).toBe("into_cli");
    expect(steerReach(deps(true, false), "nix")).toBe("after_prompt");
    expect(steerAck(deps(false, false), "nova")).toBe(STEER_ACK);
    expect(steerAck(deps(true, true), "nix")).toBe(STEER_ACK);
    // It said "before my next step", and the CLI read it when its prompt ended — hours, in a mission.
    expect(steerAck(deps(true, false), "nix")).toBe(STEER_ACK_AFTER_PROMPT);
  });
});
