/**
 * Whether an agent's working text is English — a plan step, a note, a task for another agent, a helper's brief.
 *
 * A false alarm costs a refused call the agent has to write again, so most of this is English that must pass: short
 * technical steps, identifiers, paths and command lines, a person's words quoted in their own language, names, and the
 * tables and code blocks a brief carries in the language its work is about. Memory's check is judged by its own tests
 * (`tag-gate.test.ts`); here, that it is not the work check's.
 */

import { describe, expect, test } from "bun:test";
import { memoryTextIsEnglish, workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/english.ts";

/** English working text that memory's own check refuses: a command's name, a file's extension, a compound. */
const CODE_ON_MEMORYS_LIST = [
  "Check du -sh output",
  "du -sh /var/lib/docker",
  "du /var/lib",
  "ls -la /srv/nouride && du -sh *",
  "Fix the non-empty check in config.ini",
  // `du` anywhere on a line, and words of memory's list English uses as they are.
  "Run du /var/lib",
  "sudo du /var/lib/docker",
  "Then run du /srv/share",
  "cd /srv && du .",
  "find /srv -type d | xargs du",
  "nice du /srv",
  "Check du output",
  "Update es locale",
  "Add es and pt locales",
  "Fix non root build",
  "Remove del statements",
  "Book van service",
  "Smith et al. measured it",
];

describe("English working text passes", () => {
  test("short technical steps", () => {
    for (const step of [
      "Survey the code",
      "Write evidence.md",
      "Push",
      "Merge --no-ff into releases/v0.8.8, push releases/v0.8.8 only",
      "Item 1: working-language rule in global harness + CLI instruction, with tests; commit",
      "Sabotage each fix, record failing test output; full lint:check; affected tests vs base",
      "Restart nouride.service and read journalctl -u nouride -n 50",
      "Set target to es2022 in tsconfig.json",
      "Done: tests pass (llm 564/0); files: a.ts, b.ts; ids: msn_123, job_7",
    ]) {
      expect([step, workTextIsEnglish(step)]).toEqual([step, true]);
    }
  });

  test("code identifiers, paths and command lines", () => {
    for (const line of [
      ...CODE_ON_MEMORYS_LIST,
      "Run bun test ./apps/engine/tests/missions/",
      "docker compose up -d && docker logs app --tail 100",
      "git push origin releases/v0.8.8",
      "Moved memoryTextIsEnglish into WRITE_IN_ENGLISH's module; msn_8cfcf6677f done",
      "1. du -sh /srv\n2. ls -la /srv/nouride\n- rm -rf /tmp/nouride-missions-*",
      "```bash\ncd /srv && du -sh * | sort -h\n```\nRun that on the NAS and send back the biggest five.",
    ]) {
      expect([line, workTextIsEnglish(line)]).toEqual([line, true]);
    }
  });

  test("a person's words quoted in their own language", () => {
    for (const brief of [
      'Gading asked: "bisa lu settingin ga pemindahannya?" Please move the share from the old NAS to the new one and report back.',
      "Mira wrote “tolong cek log di server ya, ada error dari tadi pagi” — check the nginx logs on box-2 and tell me what you find.",
      "The person said 'jangan push ke main dulu' so keep it on the branch.",
      "The person wrote:\n> tolong cek semua log di server nas dan kasih tau kalau ada error\nCheck /var/log on the NAS for errors since 06:00 and list them with their paths.",
      // Quote styles memory's pattern does not take, and a quote line in a list.
      "Анна wrote «проверь логи на сервере» — check the nginx logs on box-2.",
      "Mira wrote „tolong cek log di server ya“ — check the nginx logs on box-2.",
      "- > tolong cek semua log di server nas\n- Check /var/log on the NAS for errors.",
    ]) {
      expect([brief, workTextIsEnglish(brief)]).toEqual([brief, true]);
    }
  });

  test("names, in Latin letters and in other scripts", () => {
    for (const text of [
      "Ask nouva and nox; Dewi, Putu and Wayan confirmed",
      "Call Gading about the NAS",
      "Ask Анна about the invoice",
      "Send the invoice to 田中 by Friday",
      // A name that opens a line — a list of who did what, as a note's "Done" holds.
      "Анна confirmed",
      "- Анна: invoice paid",
      "Анна: paid\nМария: pending\nIvan: paid",
      "Γιώργος approved the PR",
      "1. Мария checks the backup",
    ]) {
      expect([text, workTextIsEnglish(text)]).toEqual([text, true]);
    }
  });
});

describe("working text in another language is refused", () => {
  test("Indonesian steps, notes and briefs, quoted English or not", () => {
    for (const text of [
      "Cek semua file yang sudah diubah dan jalankan test",
      "Jalankan test di worktree",
      "Commit dan push ke branch",
      "Push ke main",
      "Perbaiki bug di parser",
      "Tolong cek log di server NAS, ada error dari tadi pagi. Kasih tau hasilnya ya.",
      "Gading minta: pindahkan share dari NAS lama ke NAS baru, terus kabari kalau sudah",
      // Code in it does not make it English: what is left is judged.
      "Jalankan `bun test` di ./apps/engine dan cek apakah ada yang gagal",
    ]) {
      expect([text, workTextIsEnglish(text)]).toEqual([text, false]);
    }
  });

  test("and other languages, in Latin letters and in other scripts", () => {
    for (const text of [
      "El usuario quiere que revises los registros del servidor",
      "Vérifie les journaux du serveur et dis-moi ce qui ne va pas",
      "Prüfe die Logs auf dem Server und sag mir, was nicht stimmt",
      "サーバーのログを確認してください",
      "Проверь логи nginx на сервере",
    ]) {
      expect([text, workTextIsEnglish(text)]).toEqual([text, false]);
    }
  });

  test("the answer says what to do, and that nothing was kept", () => {
    const answer = writeWorkInEnglish("The task");
    expect(answer).toStartWith("The task is not in English.");
    expect(answer).toContain("only what reaches the person is in their language");
    // Tables too, since their rows are not judged: told only of code, a model rewriting a translation's brief in
    // English would translate the strings it is about.
    expect(answer).toContain("Nothing was kept or sent: write it again in English. A person's words may stay as they said them, in quotation marks, and names, paths, code and tables as they are.");
  });
});

/** A translation task's strings: the data a brief carries in the language the work is about. */
const STRINGS_TABLE = [
  "| Key | Indonesian |",
  "|---|---|",
  "| approvals.empty | Tidak ada yang menunggu jawaban di chat ini |",
  "| approvals.always | Selalu untuk job ini |",
  "| approvals.expired | Permintaan ini sudah kedaluwarsa dan gak dijalankan |",
  "| approvals.admin | Hanya admin yang bisa menjawab ini |",
  "| approvals.denied | Ditolak oleh kamu |",
].join("\n");

describe("data in a brief is not its language (D5)", () => {
  test("an English brief carrying another language's UI strings, in a table or as code, is English", () => {
    for (const brief of [
      `Review the Indonesian strings of the Approvals card below against docs/glossary.md, fix the ones that do not follow it, and keep the keys as they are.\n\n${STRINGS_TABLE}\n\nReport which keys you changed.`,
      // A table with no outer pipes, the way GFM also writes one.
      "Check these two strings against the glossary.\n\nKey | Indonesian\n--- | ---\napprovals.always | Selalu untuk job ini\napprovals.admin | Hanya admin yang bisa menjawab ini",
      // A fence of tildes, and one indented in a list item: blocks the quote rule's backticks never took.
      "Write these into src/locales/id.properties as they are:\n\n~~~properties\napprovals.empty=Tidak ada yang menunggu jawaban di chat ini\napprovals.admin=Hanya admin yang bisa menjawab ini\napprovals.expired=Permintaan ini sudah kedaluwarsa dan gak dijalankan\n~~~\n\nThen run the i18n check.",
      "1. Add the strings:\n   ~~~text\n   approvals.always: Selalu untuk job ini\n   approvals.admin: Hanya admin yang bisa menjawab ini\n   approvals.expired: Permintaan ini sudah kedaluwarsa dan gak dijalankan\n   ~~~\n2. Run the i18n check and report what it says.",
      // Inline code, as the quote rule has always taken it.
      "The Always button should read `Selalu untuk job ini` and the empty state `Tidak ada yang menunggu jawaban di chat ini`; change only those two keys.",
    ]) {
      expect([brief, workTextIsEnglish(brief)]).toEqual([brief, true]);
    }
  });

  test("a brief in Indonesian prose is refused, its table and code blocks or not", () => {
    for (const brief of [
      "Terjemahkan kartu Approvals ke bahasa Indonesia. Pakai glosarium yang sudah ada, jangan ubah key-nya, dan tulis hasilnya ke src/locales/id.json.",
      `Cek terjemahan di bawah ini, perbaiki yang belum sesuai glosarium, dan jangan ubah key-nya.\n\n${STRINGS_TABLE}`,
      // A sentence written right under a table is judged, where GFM would make it one more row.
      `${STRINGS_TABLE}\nTolong cek apakah semua terjemahan di atas sudah benar dan kabari aku kalau ada yang salah.`,
      // A block ends at its closing fence: what follows is judged.
      "```bash\nbun run i18n:check\n```\nJalankan perintah di atas, lalu cek apakah semua string sudah diterjemahkan dan kirim hasilnya ke aku.",
    ]) {
      expect([brief, workTextIsEnglish(brief)]).toEqual([brief, false]);
    }
  });

  test("Indonesian prose is refused beside a small English table, which does not count for it either", () => {
    const table = "| Key | Text |\n|---|---|\n| approvals.empty | Nothing is waiting for an answer in this chat |\n| approvals.expired | This request has expired and was not run |";
    for (const brief of [
      // Counted, the table's English would outweigh the sentence.
      `Cek dulu tabel ini, terus kabari aku.\n\n${table}`,
      `Tolong cek apakah semua string di tabel ini sudah benar, terus kabari aku kalau ada yang salah.\n\n${table}`,
    ]) {
      expect([brief, workTextIsEnglish(brief)]).toEqual([brief, false]);
    }
  });
});

describe("where it is still strict", () => {
  test("`ini` is counted, as Indonesian's \"this\": a short step naming an ini file bare is refused", () => {
    // Known and kept: dropping `ini` would let "Cek file ini" through. `config.ini` and `.ini` are code, and pass.
    expect(workTextIsEnglish("Parse ini files")).toBe(false);
    expect(workTextIsEnglish("Parse the .ini files")).toBe(true);
  });

  test("known misses: short text with none of the words counted, and a verb in another script taken for a name", () => {
    // Kept on purpose: refusing these would refuse English too — "Анна confirmed" looks like "Перезапусти nginx".
    for (const text of ["Perbaiki bug parser", "Перезапусти nginx", "Il server non funziona"]) expect([text, workTextIsEnglish(text)]).toEqual([text, true]);
  });
});

describe("memory's check is its own", () => {
  test("what the work check lets through as code, memory still judges as words", () => {
    // With memory's check moved onto the prose, every one of these would pass.
    for (const text of CODE_ON_MEMORYS_LIST) expect([text, memoryTextIsEnglish(text)]).toEqual([text, false]);
  });
});
