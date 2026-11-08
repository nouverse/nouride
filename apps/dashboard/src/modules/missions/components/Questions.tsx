/**
 * The questions the mission asked and what it was told, oldest first — and, while it waits on one, the box to answer
 * it. One question at a time: a mission asks only when it cannot go on without a person.
 */

import { useState } from "react";
import { Send } from "lucide-react";
import type { MissionAnswered } from "@nouride/wire";

export function AnswerBox({ onAnswer, pending, disabled }: { onAnswer: (text: string) => void; pending: boolean; disabled: boolean }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) onAnswer(text.trim());
      }}
    >
      <label className="block min-w-0 flex-1">
        <span className="sr-only">Your answer</span>
        <textarea
          className="textarea textarea-sm w-full rounded-xl leading-relaxed"
          rows={2}
          value={text}
          disabled={disabled || pending}
          placeholder="Your answer"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button type="submit" className="btn btn-primary btn-sm gap-1.5 rounded-xl" disabled={disabled || pending || !text.trim()}>
        {pending ? <span className="loading loading-spinner loading-xs" /> : <Send size={14} aria-hidden="true" />}
        Answer
      </button>
    </form>
  );
}

export function Questions({ answers }: { answers: MissionAnswered[] }) {
  if (answers.length === 0) return <p className="text-sm text-base-content/65">It has asked nothing.</p>;
  return (
    <ul className="space-y-3">
      {answers.map((entry, index) => (
        <li key={`${entry.at}-${index}`} className="space-y-1.5">
          <p className="w-fit max-w-full rounded-2xl rounded-tl-xs border border-base-content/[0.06] bg-base-200/70 px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]">
            {entry.question}
          </p>
          {entry.answer === undefined ? (
            <p className="pl-1 font-mono text-[11px] text-warning">waiting for an answer</p>
          ) : (
            <p className="ml-auto w-fit max-w-full rounded-2xl rounded-tr-xs bg-secondary/20 px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]">
              {entry.answer}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
