---
title: Ikhtisar & desain
description: Bagaimana satu proses menjalankan banyak agent, di mana batas-batasnya, dan kenapa batas itu ada di situ.
---

Nouride adalah satu proses berumur panjang. Semua di bawah ini terjadi di dalamnya: agent, gateway,
tool loop, scheduler, HTTP server dan dashboard yang disajikannya. Di sampingnya cuma jalan apa yang dinyalakan agent:
perintahnya, server MCP stdio-nya, dan CLI coding milik [agent eksternal](/id/docs/manual/external-agents/), satu
proses per agent, dinyalakan di giliran pertamanya dan dimatikan setelah lima menit diam.

## Jalur yang ditempuh sebuah pesan

```
  Discord WS        polling Telegram      WhatsApp (in-process)      dashboard / CLI
      │                  │                       │                       │
      └───────────── adapter gateway ────────────┴───────────────────────┘
                         │  envelope yang sudah dinormalkan
                         ▼
                   log room      ── pesan di grup disimpan, disapa atau gak
                         │
                         ▼
                gerbang akses    ── apakah pengirim ini boleh mencapai agent sama sekali?
                         │
                         ▼
                   inbox         ── dicatat sebelum apa pun bertindak atasnya
                         │
                         ▼
                   antrean       ── satu giliran sekaligus di DM, beberapa di grup
                         │
                         ▼
                   router        ── mention? pemilik gateway? channel binding? orchestrator?
                         │
                         ▼
                   hooks         ── ini perintah slash? jawab lalu berhenti
                         │  bukan
                         ▼
              registry agent     ── persona pack, tool dan skill-nya untuk giliran ini
                         │
                         ▼
        prompt → konteks → executor ─────────┐
                         ▲                    │ model meminta sebuah tool
                         │                    ▼
                         │     registry tool → gerbang approval → jalankan
                         └──── hasil tool ────┘
                         │  teks akhir           (tiap langkah dicatat di jurnal)
                         ▼
                   gateway.send()
```

**Gerbang akses jalan sebelum apa pun masuk antrean.** Pesan orang asing gak memulai giliran, gak
memakan panggilan model, dan gak dibalas. Di grup, pesannya tetap disimpan bersama pesan lain di room
itu: begitu agent di-tag di sana, `[agents] group_context_messages` (20) pesan terakhir diputar ulang
ke agent sebagai konteks, termasuk pesan orang asing tadi. Ikut dengar bukan berarti ikut perintah.

**Antrean dikunci per chat, bukan per agent.** Di chat empat mata, satu giliran jalan dalam satu
waktu, jadi tiap jawaban jadi konteks untuk giliran berikutnya. Di grup, tiap agent punya percakapan
sendiri, jadi beberapa giliran bisa jalan sekaligus, tapi gak pernah dua untuk agent yang sama: pesan
ke agent yang masih bekerja di situ ditolak dengan catatan, bukan diantrekan di belakangnya. Antar
chat, giliran jalan paralel sampai `[queue] max_concurrent_turns` (8). Itu sebabnya memori naik
mengikuti jumlah *giliran serentak*, bukan jumlah agent. Perintah slash menyalip antrean, jadi
`/stop` dan `/approve` tetap dijawab selagi sebuah giliran berjalan.

Empat hal terjadi di luar jalur itu:

- **Scheduler** menjalankan job yang jatuh tempo. Job yang jalan di percakapan milik chat itu sendiri
  masuk antrean seperti pesan biasa. Hasil job lainnya diantar scheduler sendiri, ke sebuah chat,
  webhook, atau gak ke mana-mana, karena catatan run-nya tetap butuh teks itu.
- **Background job** membangunkan agent yang memulainya saat job selesai, dan saat job sudah lama
  diam, lewat antrean yang sama.
- **Agent saling menghubungi** lewat mention di chat bersama, di-routing seperti pesan biasa dengan
  batas lompatan (`[agents] mention_max_hops`, 5), atau lewat `ask_agent` di chat empat mata, yang
  menjalankan agent lain di belakang percakapan lalu mengembalikan jawabannya, atau, kalau itu makan
  lebih dari semenit, membiarkannya lanjut sebagai background job yang jawabannya membangunkan agent
  yang meminta.
- **Gerbang approval** memarkir sebuah tool call sampai manusia menjawab, di chat atau di dashboard.
  Pertanyaannya berupa baris di SQLite, dan restart membuatnya kedaluwarsa, bukan membiarkan tool call
  itu menebak-nebak.

## Restart gak menghilangkan apa pun

Tiap langkah sebuah giliran ditulis ke SQLite saat itu juga: pertanyaannya, tiap balasan model
beserta tool call yang dimintanya, tiap hasilnya. Mulainya sebuah tool call ditulis tepat sebelum
tool itu jalan.

- **Saat shutdown** (`systemctl stop`, sebuah update), giliran yang sedang jalan berhenti di langkah
  berikutnya, ditutup dengan apa yang sudah dikerjakan, dan mengabarkannya di chat masing-masing
  sebelum daemon mati.
- **Setelah crash** atau listrik padam, boot berikutnya menutup tiap giliran yang tertinggal terbuka:
  setiap tool call yang selesai menyimpan hasilnya, yang sedang jalan ditandai terpotong (mungkin
  sudah jalan sebagian), dan agent mengabarkannya ke chat.
- **Giliran yang terpotong dilanjutkan** dengan sendirinya, sekali, kalau daemon kembali dalam 15
  menit: agent mengecek dulu apa yang dilakukan langkah yang terpotong sebelum mengulangnya. Kalau
  kembalinya lebih lama dari itu, gak ada yang dijalankan dengan sendirinya, dan "lanjut"
  melanjutkan dari situ.
- **Pesan dicatat begitu tiba.** Pesan yang dikirim saat daemon mati dijawab begitu daemon kembali,
  kalau dikirim dalam 15 menit terakhir; yang lebih lama mendapat catatan, bukan jawaban yang telat.
  Pesan yang dikirim dua kali oleh platform cuma dijawab sekali.
- **Balasan yang sempat ditulis tepat sebelum crash** dikirim setelah restart.

Restart atau update menunggu sampai gak ada yang berjalan: giliran atau approval paling lama sepuluh
menit, background job sampai selesai. [Update →](/id/docs/deployment/updating/)

## Apa lagi yang ada di dalam prosesnya

- **Dashboard dan CLI** bicara dengan daemon lewat control API HTTP yang sama, jadi apa pun yang bisa
  dilakukan dashboard bisa di-script. Beberapa perintah, seperti `nouride db`, `doctor` dan `service`,
  tetap jalan saat daemon mati.
- **Provider** adalah endpoint yang memakai salah satu dari dua wire format, milik Anthropic atau
  OpenAI. Apa pun yang memakai salah satunya bisa dipakai: API vendor, server model lokal, sebuah
  gateway.
- **Secret lewat nama.** `api_key = "nougate"` berarti "secret bernama nougate", diselesaikan saat
  dipakai dari environment atau secret store. Itulah sebabnya `config.toml` aman untuk di-commit,
  dicetak, dan ditampilkan di dashboard.

Dua bagian yang kelihatannya butuh proses sendiri berjalan di dalam proses ini secara default:

| | |
|---|---|
| **Bridge WhatsApp** | Jalan di dalam daemon. Ia tetap bicara lewat JSON per baris, cuma pipanya berupa memori. Satu nomor WhatsApp per daemon |
| **Gateway LLM (nougate)** | Opsional. Dihubungi lewat HTTP, atau jalan di dalam daemon pada edisi Router (`[nougate] in_process`, port 18256) |

Proses kedua gak bisa berbagi runtime Bun, jadi ia membayar sekitar 36 MB lagi. Menjalankannya di
sini yang menghemat itu.

[Edisi dan unduhan →](/id/docs/deployment/binaries/)

## Kenapa satu daemon

Alternatifnya, satu container per agent, atau satu microservice per kemampuan, membeli isolasi yang
gak diminta siapa pun dan membayarnya dengan memori, permukaan operasional, dan hal yang sebenarnya
penting di sini: sebuah agent adalah direktori Markdown, bukan sebuah program. Merakit prompt gak
butuh proses.

Angkanya mendukung. Enam agent cuma 2,1 MB lebih mahal daripada satu. Heap-nya datar terhadap jumlah
agent karena prompt dirakit per giliran dan gak ditahan di memori.

Agent eksternal pengecualiannya: CLI-nya adalah program tersendiri, dan saat diam dengan satu sesi terbuka makan
sekitar 330 MB untuk Claude Code dan 190 MB untuk Codex. Makanya agent eksternal cuma ditawarkan kalau perintah agent
kebagian 512 MiB.

[Konsumsi sumber daya dan pengukurannya →](/id/docs/architecture/performance/)

## Di mana batas yang sesungguhnya

Ini layak dinyatakan terang-terangan, karena gerbang approval gampang disangka sebagai batas keamanan.

| | |
|---|---|
| **Service account** | Daemon gak jalan sebagai root: `nouride service install` menolak membuat unit yang begitu, kecuali kamu memberi `--privileged`, yang juga membuang pengerasan di bawah |
| **Launcher** | Di instalasi binary, root yang mengetik `nouride` menjalankannya sebagai service account, lewat launcher milik root, jadi root gak pernah menjalankan file yang bisa diubah akun para agent |
| **Pengerasan unit** | `ProtectSystem=strict`, `ProtectHome=read-only`, `/tmp` privat, `NoNewPrivileges`, `RestrictSUIDSGID` |
| **Tiap agent punya user sendiri** | Di service Linux dengan helper, perintah sebuah agent, CLI coding-nya, dan server MCP stdio-nya jalan sebagai user miliknya sendiri dan menjangkau folder miliknya, bukan milik agent lain atau milik daemon ([di bawah](#tiap-agent-punya-user-sendiri)) |
| **Workspace root** | Tool file sebuah agent cuma bisa menulis ke pack-nya sendiri dan workspace, kecuali kamu mendaftarkan lebih. Agent yang punya shell juga boleh membaca `HOME`-nya dan program yang terpasang. `exec` mulai di workspace, tapi sebuah perintah menjangkau apa pun yang bisa dijangkau user-nya: user milik agent itu kalau ada, service account kalau gak |
| **Gerbang akses** | Siapa yang boleh mencapai agent sama sekali |
| **Klasifier perintah** | Perintah mana yang bertanya sebelum jalan, dan penulisan mana ke instalasi daemon sendiri yang ditolak. **Bukan** batas keamanan: model yang bertekad bisa memutari klasifier apa pun |

Klasifier ada supaya pekerjaan biasa gak mengejutkan kamu. Sisanya yang benar-benar menahan.

## Tiap agent punya user sendiri

Di service Linux yang di-install pakai `install.sh`, perintah tiap agent jalan sebagai user miliknya sendiri,
`nr-<agent>`, lewat `nouride-run`, helper root kecil yang ditaruh installer di `/usr/local/lib/nouride-run/`. Daemon
jalan dengan `NoNewPrivileges` dan gak bisa ganti user; helper itu cuma mengerjakan satu hal itu, dengan aturan tetap,
dan cuma untuk user yang dibuatnya sendiri. User tiap agent masuk grup `nr-agents`; yang pack-nya mengizinkan direktori
kredensial (`[security] credentials`, nyala kecuali ditulis `false`) juga masuk `nr-creds`.

Yang jalan sebagai agent:

- perintahnya: `exec`, background job, `session`, perintah terjadwal;
- CLI coding milik [agent eksternal](/id/docs/manual/external-agents/), beserta login-nya;
- server MCP stdio yang dipakainya, dengan HOME dan program terpasang milik agent itu, mulai di folder-nya kecuali
  server-nya menyebut `cwd`.

Yang tetap milik daemon: tool `nouride`, yang menjalankan CLI install ini sendiri, dan `nouride tools run`.

HOME sebuah agent adalah folder-nya sendiri, `workspace/private/<id>/`, diisi sekali dari `home/` bersama dengan
login dan pengaturannya, tanpa cache-nya. Yang di-install agent sendiri masuk ke `~/.local` miliknya, paling depan di
`PATH`-nya. Program yang dijalankan semua agent, di `.nouride/bin`, `lib`, dan `opt`, bisa dijalankan semua agent dan
cuma berubah lewat `nouride tools run`, yang bisa dijangkau orchestrator dan selalu disetujui orang. Perintah sebuah
agent menjangkau `workspace/shared/`, folder-nya sendiri, root yang dideklarasikannya, pack-nya, serta log job,
lampiran, dan output tool panjang miliknya sendiri: gak ada yang milik agent lain, dan gak ada yang di `data/`.
`[security.exec] landlock` menambahkan Landlock kalau kernel-nya punya.

Di Docker, di macOS, atau di Linux tanpa helper (gak ada systemd, atau gak ada `useradd`, seperti Alpine tanpa
`shadow`), semuanya jalan sebagai user daemon, seperti dulu: perintah satu agent bisa membaca folder agent lain dan
file milik daemon, dan `home/` adalah HOME semua agent. Saat boot dan `nouride doctor` bilang yang mana, dan kenapa. Di
sana *Free in its folder* milik agent eksternal nanya seperti *Ask when risky*, dan server MCP shell atau file bisa
membaca apa yang bisa dibaca daemon.
