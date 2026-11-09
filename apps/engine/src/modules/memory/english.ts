/**
 * Whether a piece of memory is English — the check every writer runs before anything is kept.
 *
 * Memory is English whatever a conversation was in: it is read across chats in several languages, and
 * a profile whose facts switch language line by line can be neither searched nor deduplicated by its
 * words. The prompts have always asked for it, and on a production box a summary still came back in
 * Indonesian now and then (1 of 898 on 2026-10-11), so asking is not enough. Transcripts are the one exception:
 * a record of what was said stays as it was said.
 *
 * No language detector and no dictionary, on purpose: a dependency for one yes/no, and a dictionary
 * would refuse the words memory is full of (`proxmox`, `tailscale`, a person's name). What this counts
 * instead are function words — the, of, is, which every English sentence has, and yang, di, dan or
 * que, der, les, which a sentence in another language has instead — plus how much of the text is in a
 * script other than Latin. Names and quoted terms are kept as written by every prompt, so they are
 * left out of the count: a capitalised word, and anything in quotes.
 *
 * Pure.
 */

/** English words a sentence of any length is made of. */
const ENGLISH = new Set(
  (
    "the a an and or of to in on at for with is are was were be been being has have had it its this that these those " +
    "as by from not but he she they his her their them him we our you your my will would can could should about after " +
    "before who which what when where there than then also into over out up so if no all some any more most very only " +
    "because while during through between both each other such now how why does did do just own same new"
  ).split(" "),
);

/**
 * The same words in the languages written in Latin letters that memory may meet: Indonesian and its
 * neighbours first, then the large European ones, then more of Asia and Africa. Every other script is
 * caught by its letters instead.
 *
 * Only words English text never has: a false alarm costs a re-ask and can leave a conversation unfiled,
 * while a miss costs one summary in another language. So `die`, `in`, `con`, `um`, `per` (English too),
 * `com`, `ng`, `lo`, `su` (`.com`, Angular's CLI, `lo-fi`, `sudo su`), `kung` (`kung pao`), `jest`,
 * `ale`, `care`, `sing`, `nous` and single letters are left out on purpose.
 */
const OTHER = new Set(
  (
    // Indonesian and Malay, Javanese, Sundanese, Tagalog
    "yang dan di ke dari ini itu untuk dengan tidak akan bisa sudah juga ada atau karena jadi saya aku kamu dia " +
    "mereka kita kami belum sedang mau ingin lagi pada oleh tapi kalau sama buat gimana udah aja adalah dalam bahwa " +
    "telah sebagai seperti hanya lebih sangat bagi agar supaya harus perlu masih sekarang kemarin besok tadi nanti " +
    "banget gak nggak dong deh sih kok lah kan nya " +
    "ora kowe karo opo piye teu anjeun jeung " +
    "mga hindi siya ako ito naman " +
    // Spanish, Portuguese, French, Italian, German, Dutch
    "el la los las del que por para una es esta pero como muy más está también porque cuando donde " +
    "não uma você isso também mais muito então ainda " +
    "le les des du et est une avec pour dans sur pas qui vous mais très sont " +
    "il che della degli sono non anche questo perché molto " +
    "der das und ist nicht mit ein eine auf für ich sie auch noch wir aber oder wenn dass sich " +
    "het een niet van zijn voor maar ook " +
    // Swedish, Norwegian and Danish; Polish, Czech and Slovak; Romanian; Turkish; Vietnamese; Swahili
    "och är på för inte ikke jeg " +
    "się że oraz przez który jsou není " +
    "și să pentru sunt " +
    "bir için çok gibi daha değil olarak " +
    "của và là không được những này với các một người đã " +
    "kwa katika"
  ).split(" "),
);

/** Quoted spans, in the quote styles models and people write. A single quote only after a space — `Sam's` is not a quote. */
const QUOTED = /"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`|(?<=^|\s)'[^'\n]+'(?=$|[\s.,;:!?)])/g;

/** Whether `text` reads as English — true for what has no words to judge (empty, numbers, a name). */
export function memoryTextIsEnglish(text: string): boolean {
  const unquoted = text.replace(QUOTED, " ");
  const letters = unquoted.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const latin = unquoted.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if ((letters.length - latin) / letters.length > 0.2) return false;

  // A capitalised word is a name or a sentence's first word: neither says which language it is in.
  const words = (unquoted.match(/\p{L}[\p{L}'’]*/gu) ?? []).filter((word) => word === word.toLowerCase()).map((word) => word.replace(/['’].*$/, ""));
  const english = words.filter((word) => ENGLISH.has(word)).length;
  const other = words.filter((word) => OTHER.has(word)).length;
  if (other === 0) return true;
  // Two or three words carry little grammar to weigh: one of another language's beside one of ours is a
  // borrowed term; with none of ours, it is that language.
  if (words.length <= 3) return english > 0 && other < 2;
  return english >= 2 * other;
}

/** Quote styles memory's `QUOTED` does not take, in which a person's words come quoted too: « », „ “, 「 」, 『 』. */
const MORE_QUOTED = /«[^»]*»|„[^“”"]*[“”"]|「[^」]*」|『[^』]*』/g;
/** A markdown quote line, a list item's too: a person's message quoted whole. */
const QUOTE_LINE = /^[ \t]*(?:[-*+][ \t]+)?>.*$/gm;
/** Sentence punctuation around a word, taken off before it is judged a word. */
const AROUND = /^[(["'“‘{]+|[)\]"'”’},.;:!?…]+$/gu;
const WORD = /^\p{L}[\p{L}'’]*$/u;

/**
 * Words on memory's list of other languages' that English working text uses as they are: `du` the command, Python's
 * `del`, the `es` locale, "et al.", "non root", a van. Each one's language keeps many more on that list. `ini` stays
 * counted: it is "this" in Indonesian, and a short step that names an `ini` file bare is still refused.
 */
const CODE_WORDS = new Set(["du", "del", "es", "et", "non", "van"]);

/** A fenced code block's opening line: three backticks or more with none after them, or three tildes or more. */
const FENCE = /^[ \t]*(`{3,}(?=[^`]*$)|~{3,})/;
/** A line that can close a block: a fence and nothing after it. */
const CLOSING_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/** A table's delimiter row, `|---|:--:|` or `--- | ---`: cells of dashes, a colon at either end, pipes between or around. */
function delimiterRow(line: string): boolean {
  if (!line.includes("|")) return false;
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

/**
 * `text` with its data blanked: a fenced code block, fences and all, and a markdown table — its header, its delimiter row
 * and the rows under it. A brief carries data in whatever language its work is about, the strings of a translation or a
 * log, and that is no more the brief's language than a quoted term is: an English brief with a table of Indonesian UI
 * strings was refused. A block left open runs to the end, as markdown renders it. A line with no pipe ends a table,
 * where GFM would take it as one more row: it is a sentence written under the table, and it is judged.
 */
function withoutData(text: string): string {
  const lines = text.split("\n");
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (fence === undefined) {
      fence = FENCE.exec(lines[i]!)?.[1];
      if (fence === undefined) continue;
    } else {
      const closing = CLOSING_FENCE.exec(lines[i]!)?.[1];
      if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) fence = undefined;
    }
    lines[i] = "";
  }
  for (let i = 1; i < lines.length; i++) {
    if (!delimiterRow(lines[i]!) || !lines[i - 1]!.includes("|")) continue;
    lines[i - 1] = "";
    for (let row = i; lines[row]?.includes("|"); row++) lines[row] = "";
  }
  return lines.join("\n");
}

/**
 * The prose of an agent's working text — what memory's check can judge. Code blocks and tables go (`withoutData`), as do
 * quotes and quote lines, and code: a token with anything but letters in it once its sentence punctuation is off
 * (`/var/lib`, `-sh`, `config.ini`, `non-empty`, `msn_53b16d`, `v0.8.8`, `&&`), and the words in `CODE_WORDS`. Memory,
 * which rarely holds a command line, counts them all.
 */
function prose(text: string): string {
  const lines = withoutData(text).replace(QUOTED, " ").replace(MORE_QUOTED, " ").replace(QUOTE_LINE, " ").split("\n");
  return lines
    .map((line) => {
      const words: string[] = [];
      for (const token of line.split(/\s+/)) {
        const word = token.replace(AROUND, "");
        if (!WORD.test(word) || CODE_WORDS.has(word)) continue;
        // A capitalised word is left out of the words counted (`memoryTextIsEnglish`), and here out of the letters too
        // where it is in another script: `Анна` in "Анна confirmed" is a name, not half the text in Cyrillic. Without a
        // dictionary a name and a verb look alike, so "Перезапусти nginx" passes too: a miss, where the other way round
        // refused every line of a list that opened with a name.
        if (word[0] !== word[0]!.toLowerCase() && !/\p{Script=Latin}/u.test(word)) continue;
        words.push(word);
      }
      return words.join(" ");
    })
    .join("\n");
}

/**
 * Whether an agent's working text — a plan step, a note, a task for another agent, a helper's brief, a mission's goal —
 * is English. Memory's judgement, on the prose alone (`prose`): working text is full of paths, identifiers and command
 * lines that memory rarely holds, of a person's words quoted in their own language, and of data in the language its work
 * is about. Memory keeps its own check.
 */
export function workTextIsEnglish(text: string): boolean {
  return memoryTextIsEnglish(prose(text));
}

/** What a tool that refuses working text not in English says, `what` being what it refused: "The task", "Step 2". */
export function writeWorkInEnglish(what: string): string {
  return (
    `${what} is not in English. Plans, notes and what you hand to another agent are written in English, whatever language ` +
    "the person speaks; only what reaches the person is in their language. Nothing was kept or sent: write it again in " +
    "English. A person's words may stay as they said them, in quotation marks, and names, paths, code and tables as they are."
  );
}

/** What a writer that refuses non-English text tells whoever wrote it. */
export const WRITE_IN_ENGLISH =
  "Memory is kept in English, whatever language the conversation is in. Write it again in English. Names, titles and quoted terms may stay as they are.";
