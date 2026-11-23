/**
 * One of a step's paths, asked as a question with a few answers: "If it fails": stop and tell me, go on anyway, ask me
 * first, do something else (`lib/paths.ts`). It was a dropdown that said `Go to "Ask me first"`: a jump to a step,
 * where a person asks what happens then.
 *
 * Each answer writes a shape the daemon already runs. "Ask me first" keeps its question here, where it was chosen;
 * "Do something else" draws its steps beside this one, and says here where the run goes after them.
 */

import { choiceOf, choicesFor, ruleOf, type Choice, type LaneEnds, type PathExit, type Paths } from "../lib/paths";
import { landsAt, type Step } from "../lib/steps";
import { choiceWords, exitChip } from "../lib/words";
import { Choice as ChoiceCard } from "./form-parts";
import { LaneEndPick, laneBackChoices } from "./PathRules";

export function PathChoices({
  steps,
  index,
  exit,
  paths,
  titleOf,
  onChoose,
  onQuestion,
  onLaneEnd,
}: {
  steps: readonly Step[];
  index: number;
  exit: PathExit;
  paths: Paths;
  titleOf: (step: Step) => string;
  onChoose: (choice: Exclude<Choice, "jump">) => void;
  /** The question of "Ask me first", as it is typed. */
  onQuestion: (at: number, ask: string) => void;
  onLaneEnd: (ends: LaneEnds) => void;
}) {
  const step = steps[index]!;
  const now = choiceOf(steps, index, exit, paths);
  const rule = ruleOf(paths, index, exit);
  const name = exitChip(step, exit);
  const to = landsAt(steps, index, exit);
  const jumpsTo = to === "end" ? "" : `step ${paths.line.indexOf(to) + 1}, ${titleOf(steps[to]!)}`;
  return (
    <fieldset data-path={exit} className="space-y-1.5">
      <legend className="mb-1.5 font-mono text-xs font-semibold tracking-wider text-base-content/85 uppercase">{name}</legend>
      <div role="radiogroup" aria-label={name} className="grid gap-1.5">
        {choicesFor(steps, index, exit, paths).map((choice) => {
          const words = choiceWords(step, exit, choice, jumpsTo);
          return (
            <div key={choice} className="grid">
              <ChoiceCard selected={now === choice} label={words.label} hint={words.hint} onClick={() => (choice === "jump" ? undefined : onChoose(choice))} />
              {now === choice && rule?.kind === "ask" ? (
                <label className="mt-1.5 block">
                  <span className="sr-only">Question</span>
                  <textarea
                    className="textarea w-full text-sm leading-relaxed"
                    rows={2}
                    value={(steps[rule.at] as Extract<Step, { kind: "approval" }>).ask}
                    placeholder="It did not work. Go on anyway?"
                    aria-label={`Question to ask ${name.charAt(0).toLowerCase()}${name.slice(1)}`}
                    onChange={(event) => onQuestion(rule.at, event.target.value)}
                  />
                  <span className="mt-1 block text-xs text-base-content/65">Asked where it reports, with why it failed. With no answer in a day, the run stops.</span>
                </label>
              ) : null}
              {now === choice && rule?.kind === "lane" ? (
                <div data-lane-end-field className="mt-1.5 space-y-1.5">
                  <p className="text-xs text-base-content/65">Its steps are drawn beside this one. Press one to write it. After them:</p>
                  <LaneEndPick backs={laneBackChoices(steps, index, rule, paths, titleOf)} onSet={onLaneEnd} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
