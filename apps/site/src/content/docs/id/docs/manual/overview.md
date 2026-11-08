---
title: Pemakaian sehari-hari
description: Apa yang benar-benar kamu kerjakan dengan Nouride setelah ia jalan, dan di mana letak masing-masingnya.
---

Instalasi selesai dan satu agent sudah menjawab. Begini rupa minggu-minggu berikutnya.

## Dua antarmuka, untuk dua hal berbeda

**Dashboard untuk apa pun yang dimiliki agent**: kepribadiannya, modelnya, skill-nya, siapa yang boleh
bicara dengannya, apa yang dijadwalkannya. Satu tab browser di `@@DASHBOARD_URL@@`.

**CLI untuk daemon-nya**: hidup atau gak, apa yang mengantre, apa isi audit log, restart gateway ini.
Jalan lewat SSH dan terhadap daemon jarak jauh.

Keduanya bukan versi murahan satu sama lain. Wizard setup dan `nouride setup` menjalankan kode yang
*sama*; halaman skill dan `nouride skills` menulis file yang sama.

**Keduanya bukan cara agent bekerja.** Agent bertindak lewat tool, masing-masing bertipe, ditahan
sendiri-sendiri, dan diaudit dengan nama. Agent yang memegang tool `nouride` bisa menjalankan CLI yang
sama dengan yang kamu pakai (memasang pengingat, mengecek gateway), tapi tool itu cuma pernah
menjalankan `nouride`, dan setiap panggilannya lewat gerbang dan audit yang sama dengan `exec`. Agent
gak pernah membaca control token itu sendiri.

## Yang akan kamu lakukan

| | Di mana | Halaman |
|---|---|---|
| Mengobrol dengan agent | aplikasi chat apa pun, dashboard, atau `nouride chat` | [Mengobrol](/id/docs/manual/chatting/) |
| Menjawab "boleh saya jalankan ini?" | chat tempat ia bertanya, atau dashboard | [Approval](/id/docs/manual/approvals/) |
| Mengubah perilaku agent | dashboard → Agents → Files | [Persona pack](/id/docs/architecture/agents/) |
| Ganti model | dashboard → Agents → Model | [Profil provider](/id/docs/providers/configuration/) |
| Menentukan apa yang boleh dipelajari | dashboard → Skills | [Skill & pembelajaran](/id/docs/manual/skills/) |
| Melihat apa yang diingatnya | dashboard → Memory | [Memori](/id/docs/architecture/memory/) |
| Mengizinkan atau menolak orang | dashboard → Settings → Access | [Siapa yang boleh bicara](/id/docs/manual/access/) |
| Menjadwalkan sesuatu jam 9 pagi | dashboard → Work → Schedule, `nouride cron`, atau minta saja | [Tugas terjadwal](/id/docs/manual/schedule/) |
| Melihat semua agent lagi ngapain dalam sekali lihat | dashboard → Agents → Office | [Office](/id/docs/manual/office/) |
| Bikin agent yang dijawab Claude Code atau Codex | dashboard → Agents → New Agent, atau minta orchestrator | [Agent eksternal](/id/docs/manual/external-agents/) |
| Memeriksa keadaannya | `nouride status`, `nouride doctor` | [doctor](/id/docs/cli/doctor/) |
| Backup dan upgrade | `nouride db backup`, `nouride update --start` | [Perawatan](/id/docs/manual/maintenance/) |

## Satu direktori

Satu instalasi adalah satu direktori. Ini hal paling berguna yang perlu diketahui saat
mengoperasikannya.

```
@@INSTALL_DIR@@/           (Linux)   ./nouride/   (volume Docker)
├── nouride                binary-nya
├── dashboard/             UI web yang disajikannya
├── skills/                skill bawaan daemon
├── .env                   kredensial dan nilai per-host (0600)
└── .nouride/
    ├── config.toml        semua yang struktural
    ├── data/              SQLite, secret, lampiran, backup
    ├── agents/            persona dan agent pack
    │   └── skills/        kumpulan skill - semua agent mengambil dari sini
    ├── memory/            yang diingat agent: percakapan, orang, fakta bersama
    ├── workspace/         hasil kerja para agent
    │   └── private/<id>/  folder milik satu agent: HOME-nya kalau ia punya user sendiri
    ├── home/              HOME milik daemon (ssh key, login CLI); juga milik agent kalau mereka memakai user daemon
    ├── bin/               program yang dipasang agent, paling depan di PATH-nya
    └── lib/, opt/         yang dibutuhkan program-program itu, dan env Python bersama agent
```

**Backup `.nouride/` dan `.env`.** Sisanya cuma unduhan. Di service Linux yang
[tiap agent-nya punya user sendiri](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri), ssh key, login, dan
program yang di-install sendiri oleh sebuah agent ada di `workspace/private/<id>/`-nya, jadi `workspace/` di sana bukan
cuma hasil kerja. Di Docker, macOS, atau tanpa helper, semua itu ada di `home/`. Kunci penyimpanan secret sengaja gak
ada di keduanya (0.8.19): simpan salinannya di tempat terpisah, atau atur password backup di halaman Secrets.
[Backup →](/id/docs/manual/maintenance/#backup)

## Lima perintah yang layak dihafal

```bash
nouride status          # agent, gateway, antrean: satu layar
nouride doctor          # mendiagnosis setup yang belum jalan
nouride logs -f         # log langsung; jalan tanpa journal, dan dari jarak jauh
nouride chat            # bicara dengan agent dari terminal, tanpa bot token
nouride approvals       # apa yang sedang menunggu jawaban kamu
```

Semuanya menemukan instalasinya sendiri, jadi jalan dari direktori mana pun *di mesin instalasi
itu*. Lihat catatan soal direktori kerja di
[troubleshooting](/id/docs/start/troubleshooting/#menjalankan) kalau salah satunya bilang gak ada
daemon padahal ada.

## Mengendalikan daemon jarak jauh

Kebanyakan perintah bicara ke daemon yang sedang jalan lewat control API. Beberapa yang gak, seperti
`setup`, `doctor`, `policy` dan `stop`, bekerja pada instalasi tempat ia dijalankan. Arahkan sisanya
ke tempat lain dengan dua variabel lingkungan:

```bash
export NOURIDE_URL=https://nouride.example.com
export NOURIDE_TOKEN=<isi data/.control-token mesin tersebut>
nouride status
```

## Apa yang berjalan tanpa kamu

Beberapa hal terjadi entah ada yang menonton atau gak, dan ada baiknya tahu yang mana:

- **Tugas terjadwal.** Secara default job jalan di tingkat approval `balanced`, jadi panggilan biasa
  langsung jalan: job jam 3 pagi yang berhenti di prompt yang gak akan dilihat siapa pun sama saja
  dengan gak jalan. Apa pun yang menghapus, mematikan sesuatu, mengubah infrastruktur, atau menyentuh
  kredensial langsung ditolak, dan agent bilang apa yang gak bisa dikerjakannya.
- **Reconnect.** Gateway yang putus akan mundur lalu mencoba lagi. Yang menyerah sepenuhnya memicu
  alert, kalau kamu sudah menentukan ke mana alert dikirim.
- **Menyusul setelah restart.** Pesan yang masuk selama daemon mati tetap dijawab kalau dikirim dalam
  15 menit terakhir, dan giliran yang terpotong restart bilang apa yang sudah dikerjakannya.
- **Backup.** Snapshot database saat boot lalu harian, plus salinan bertanggal dari agent pack dan
  vault memori, semuanya di `data/backups/`.
- **Sapuan retensi.** Percakapan lama, baris audit, run job dan file scratch kedaluwarsa sesuai
  jadwal di `[retention]`.
- **Proses memori malam**, kalau kamu menyalakan memori.
- **Update, di Nouride Box.** Box memasang rilis baru sendiri antara jam 2 dan 5 pagi, selama gak ada
  yang memakainya, kecuali kamu mematikannya di **My Box**.
- **Selain itu, gak ada.** Agent gak bertindak kecuali ada pesan, job, atau webhook yang
  membangunkannya.
