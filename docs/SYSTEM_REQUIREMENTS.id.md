# Kebutuhan sistem

Berapa biaya sebenarnya untuk menjalankan Nouride, dan apa yang dibutuhkan.

> **Semua angka di sini diukur, bukan diperkirakan**, dan masing-masing menyebut di mana diukurnya.
> Angka yang tidak punya pengukuran di belakangnya diberi label sebagai penalaran, dan angka yang
> diekstrapolasi dari jendela yang lebih pendek menyebutkannya.
>
> **Diukur ulang tanggal 2026-10-17**, di branch 0.7.11, Bun 1.4.2, build berbentuk rilis (`--smol`):
>
> - **linux-arm64**, binary terkompilasi di `debian:12-slim` di Docker pada host Apple M1, secara
>   native, dengan prosedur di [Menjaga dokumen ini tetap akurat](#menjaga-dokumen-ini-tetap-akurat):
>   footprint idle, agen, batas bawah.
> - **linux-x64**, prosedur yang sama, yang di host itu berjalan lewat Rosetta. Translasinya menambah
>   sekitar 31 MB memori anonim — 27,3–27,5 MB arm64 native dibanding 58,0–59,8 MB x64 teremulasi, build
>   sama, pack sama — jadi angka-angka ini adalah batas atas, diberikan untuk bentuk batas bawahnya saja.
> - **x64, secara native**, di x64 test box (2 core, 2 GB, container LXC Proxmox di atas ZFS): daemon
>   0.7.10 yang live, dengan 6 agen dan 9 gateway terhubung (enam bot Discord, Telegram, WhatsApp
>   in-process, dashboard), dibaca tanpa mengubah apa pun dari `/proc` dan cgroup service-nya selama
>   119 menit ketika daemon tidak mengerjakan apa pun: memori resident, wake-up, byte yang ditulis, CPU.
>
> **Batas bawah, diukur lagi di hari yang sama** setelah 0.7.11 menurunkan hash password ke biaya argon2id
> OWASP (19 MiB, sementara default Bun 64): linux-arm64 dengan prosedur yang sama, dan setiap start dimulai
> dingin — halaman binary dibuang dari page cache sebelum setiap run, jadi semua yang dibacanya dibebankan
> ke container yang dibatasi. Start pertama dan start berikutnya sama-sama mencapai `ready` di 64 MB.
>
>
> **Coding CLI (0.8.1)** diukur terpisah, di macOS arm64 dan bukan dengan prosedur Linux: lihat
> [Coding CLI](#terukur-coding-cli-081).
>
> **Masih belum diukur:** puncak memori sebuah turn; byte yang ditulis sehari yang berisi percakapan
> (hanya jendela idle, diekstrapolasi); baris Docker image; kartu Nouride Box, yang menunggu Box yang
> menjalankan build ini. Angka 2026-08-14 yang tidak diukur ulang (Bun 1.3.4, tree waktu itu di
> `71d6ba3`) ditandai di tempatnya, dan angka RSS `--smol` di [DEPLOY.md](./DEPLOY.md) berasal dari mesin live.

---

## Jawaban singkat

| | |
|---|---|
| **Berjalan di** | 64 MB, start pertama dan setiap start sesudahnya (2026-10-17, linux-arm64, dingin). Lambat di batas itu: puluhan detik sampai `ready`, sementara 128 MB hanya beberapa detik. ([Batas bawah](#terukur-batas-bawah).) |
| **Nyaman di** | 512 MB. 1 GB jika agen melakukan pekerjaan nyata melalui `exec`. Penalaran, bukan pengukuran: [turn di bawah beban](#belum-diukur-turn-di-bawah-beban). Coding CLI milik agen eksternal butuh 512 MiB untuk perintah para agen di luar itu: [Coding CLI](#terukur-coding-cli-081). |
| **Disk** | 120 MB terinstal (binary 117 MB, dashboard, skill), unduhan 56 MB, ditambah hasil instalasi — linux-x64 di Bun 1.4.4, diukur 2026-10-22; runtime Bun sendiri bertambah 28 MB dari 1.4.2, yang dulu 95 MB dan 40 MB. `.nouride/data/` baru berukuran 364 KB (2026-08-14); `.nouride/workspace/` tumbuh sesuai apa yang dibangun agen. |
| **CPU** | Apa saja. 0,17% dari satu core saat idle — 0,1 detik CPU per menit — di x64 test box dengan sembilan gateway terhubung; daemon menunggu jaringan hampir sepanjang waktu. |
| **Tidak butuh** | Postgres, Redis, vector database, GPU, atau model lokal. Satu file SQLite (TD-005). |

Tidak ada kebutuhan model minimum karena Nouride tidak meng-host model sendiri.
Provider adalah endpoint remote, jadi RAM tidak terpengaruh oleh model mana yang digunakan agen.

> **Yang bertambah (2026-10-12):** bukan hanya `.nouride/workspace/`. Tiga bagian lain dari `.nouride/`
> ikut bertambah seiring pemakaian: `memory/`, vault memori, satu file per percakapan; `bin/`, `lib/`,
> `opt/` dan `home/`, yaitu program yang diinstal agen beserta cache tool-nya, yang ukurannya ditampilkan
> `nouride doctor`; dan `data/`, yang database-nya kini juga menyimpan indeks memori, dan yang
> `backups/`-nya menyimpan salinan harian database, pack agen, dan vault. Diukur sekali, di x64 test box
> (2026-10-17): database 41 MB, dan delapan snapshot terakhirnya masing-masing 30 sampai 36 MB. Selebihnya
> belum diukur.

---

## Terukur: footprint idle

Daemon dalam keadaan diam, gateway terhubung, tidak ada turn yang sedang berjalan. Memori resident terdiri
dari dua hal, dan hanya satu yang benar-benar menekan memori: halaman executable yang dipetakan dari disk,
yang dibuang kernel dan dibaca ulang saat memori sempit, dan memori anonim — heap dan runtime — yang tidak
bisa dibuang. Kolom kedua adalah yang dipakai untuk menghitung kapasitas.

| Bentuk | Resident idle | darinya, anonim | Puncak saat boot | Ukuran artefak |
|---|---|---|---|---|
| Binary terkompilasi, linux-arm64, 1 agen (Docker di M1, 2026-10-17) | 59,0–67,5 MB | **27,3–27,5 MB** | 145,6 MB | 94 MB terinstal, unduhan 40 MB |
| Binary terkompilasi, linux-x64 lewat Rosetta, 1 agen (2026-10-17, batas atas) | 84–103 MB | 58,0–59,8 MB | 175–179 MB | 95 MB terinstal, unduhan 40 MB |
| x64 test box, 0.7.10 live, 6 agen, 9 gateway (2026-10-17) | 117–128 MB | **87–98 MB** | 206 MB sejak start, termasuk turn | — |
| Pro Router, Linux arm64 (Pi Zero 2 W), 1 agen, LLM gateway in-process (2026-10-15) | **80,0 MB** — heap 33,9 MB, halaman binary 46,0 MB | — | 86,2 MB | binary 90 MB, + dashboard dan frontend gateway |
| Binary terkompilasi, macOS, 0 agen (2026-08-14, belum diukur ulang) | 63,7 MB | — | — | 58 MB |
| Docker image (2026-08-14, Bun menjalankan `.ts`, belum diukur ulang) | 69 MB proses / 96 MB container | — | 166 MB | 85 MB image |

Disampling setiap 15 detik selama satu menit setelah `ready` (linux-arm64): resident 73,4 MB, lalu antara
59,0 dan 67,5 MB seiring halaman binary dibuang dan dibaca ulang; anonim 33,6 MB, lalu datar di
27,3–27,5 MB; 16 thread, lalu 5. Build 2026-08-14 terukur 74,5 MB resident dan puncak 139,7 MB dengan
cara yang sama.

**Box live membawa apa yang tidak dibawa tes yang sepi:** enam bot Discord dan sesi WhatsApp yang dipegang
in-process, buffer sembilan koneksi, database 41 MB, dan cache yang ditinggalkan sehari penuh turn.
Dibaca dari `/proc/<pid>/status` sekali per menit selama 119 menit ketika daemon tidak mengerjakan apa
pun: resident 117,1–128,1 MB, anonim 87,2–98,2 MB, halaman binary sekitar 30 MB; cgroup service-nya,
termasuk page cache, median 109,2 MiB. Datar kecuali satu lonjakan: sekitar 10 MB memori anonim lebih
banyak dan hingga tiga thread tambahan selama tiga menit, satu jam setelah mulai, lalu menetap sekitar
5 MB di atas titik awalnya — tidak ada yang tercatat di database, log, atau event stream yang
menjelaskannya. Mesin yang sama terukur 65,6 MB resident dan 41,4 MB anonim pada 2026-09-02, dengan
`--smol` ([DEPLOY.md](./DEPLOY.md)); sejak itu bridge WhatsApp pindah ke dalam daemon (2026-09-16), dan
indeks memori serta event stream ditambahkan.

**Bagaimana selisihnya terbagi (2026-10-17), dan tidak ada leak di dalamnya.** Baseline idle engine itu
sendiri naik 5–6 MB dari v0.1.0 (2026-09-10) ke branch 0.7.11 — terukur: binary linux-arm64 `--smol`
setiap tag, Bun 1.4.2 untuk semuanya, config yang sama tanpa gateway, anonim 16,2–17,8 MB waktu itu
melawan 22,3–22,6 MB sekarang dengan satu agen; heap JS-nya setelah full collection 3,4 MB di v0.6.0
melawan 4,2 MB sekarang, lebih banyak modul dan fungsi, bukan lebih banyak data. Bridge WhatsApp di
dalam daemon +21,3 MB (terukur: halaman performance di situs, proses terpisah versus di-bundle). Sisanya
penalaran, bukan pengukuran: page cache SQLite, 2 MB sampai 2026-10-11 dan 16 MB sejak itu, terisi
seiring pemakaian pada database 41 MB — sampai 14 MB; kode edisi Pro; dan apa yang ditinggalkan sehari
turn — kode terkompilasi, halaman allocator yang disimpan setelah puncak 206 MB, cache guild dan channel
enam bot Discord (cache message, user, dan member-nya 0). Langkah 10 MB belum terjelaskan: tidak ada
baris log di jendela itu, dan adapter Discord tidak mencatat resume. Dua map yang tumbuh dengan setiap
percakapan yang pernah dilihat — tampilan aktivitas dan pemberitahuan pesan terlambat — dibatasi sejak
0.7.11.

**Baris Pro Router berisi dua angka, dan hanya satu yang benar-benar menekan memori.** Diukur di Nouride
Box pada 2026-10-15, dengan gateway Telegram dan dashboard terhubung serta `--smol` seperti semua rilis:
dari 80 MB yang resident, 46 MB adalah halaman executable 90 MB yang dipetakan dari disk, yang dibuang
kernel dan dibaca ulang saat memori sempit — dan 34 MB adalah heap, yang tidak bisa dibuang. Box yang
sama terbaca 100 MB tepat setelah reboot dan 80 MB tujuh jam kemudian tanpa ada yang berubah: selisihnya
adalah halaman binary yang belum dibuang. Menjalankan gateway di proses yang sama (`[nougate] in_process`)
memakan beberapa megabyte heap — 33,2 MB untuk edisi Pro biasa di board yang sama
([DEPLOY.md](./DEPLOY.md)), 33,9 sampai 39 MB di sini — sedangkan proses kedua akan memakan runtime Bun
kedua. Halaman LLM Gateway (dashboard gateway di dalam dashboard ini) tidak menambah apa pun yang
terukur saat diam: 80,2 MB sebelumnya, 80,0 MB sesudahnya.
Datar, tanpa drift, 12 thread dan tanpa child process.

Puncak saat boot kira-kira dua kali angka saat istirahat, dan itulah yang harus diakomodasi oleh batas
memori, bukan angka saat istirahat. Pada start pertama, sebagian besar selisihnya dulu adalah satu
alokasi: akun dashboard dibuat dan password-nya di-hash dengan argon2id, dan dengan parameter Bun —
`m=65536,t=2,p=1`, 64 MiB — memori anonim naik dari 29 ke 95 MB dalam 20 ms setelah "persona packs backed
up" (boot ditelusuri setiap 10 ms, sebelum 0.7.11). Sejak 0.7.11 hash-nya memakai biaya OWASP
`m=19456,t=2,p=1`, 19 MiB selama sekitar 20 ms, dan sign-in memverifikasi dengan biaya yang tercatat di hash
tersimpannya: akun yang dibuat sebelumnya membayar 64 MiB sekali lagi, di sign-in pertamanya, lalu di-hash
ulang di 19 MiB.

Binary terkompilasi dan image berada dalam selisih ~10 MB satu sama lain.
Image menjalankan TypeScript melalui Bun secara langsung alih-alih bundle terkompilasi, yang memakan
sedikit lebih banyak saat boot; perbedaan keduanya tidak cukup besar untuk menjadi dasar pemilihan
antara kedua bentuk tersebut berdasarkan memori.

> **2026-10-12:** image sekarang menjalankan satu bundle, `nouride.bundle.js`, yang dibangun dari source
> yang sama, bukan file `.ts`. Baris Docker di atas diukur sebelum perubahan itu dan belum diukur ulang.
Pilih berdasarkan pertimbangan di [DEPLOY.md](./DEPLOY.md) — apakah agen harus bisa bertindak di host.

## Terukur: batas bawah

Dijalankan di bawah batas cgroup keras dengan swap mati, sambil memeriksa apakah daemon mencatat
"nouride ready" — dua kali, karena kedua start itu tidak sama: **start pertama** membuat akun dashboard
dan meng-hash password-nya, dan **start berikutnya** sudah mendapatinya. linux-arm64, 1 agen, dashboard
menyala, 2026-10-17, di branch 0.7.11 dengan hash password pada biaya OWASP (19 MiB, di atas). **Setiap
start dimulai dingin:** halaman binary dibuang dari page cache sebelum setiap run, jadi semua yang
dibacanya dibebankan ke container yang dibatasi. "Di-kill" adalah OOM killer cgroup; waktunya sampai
`ready`, di host Docker yang sedang sibuk.

| Batas | Start pertama | Start berikutnya |
|---|---|---|
| 128 MB | ready, 2/2 — 2–5 dtk | ready, 2/2 — 1–3 dtk |
| 96 MB | ready, 2/2 — 3–5 dtk | ready, 2/2 — 1–4 dtk |
| 80 MB | ready, 2/2 — 5–8 dtk | ready, 2/2 — 2–8 dtk |
| 72 MB | ready, 2/2 — 4–11 dtk | ready, 2/2 — 3–14 dtk |
| **64 MB** | **ready, 4/4** — 9–68 dtk, anonim 26–30 MB | **ready, 2/2** — 16–22 dtk, anonim 25 MB |
| 56 MB | ready 2/4, di-kill 2/4 | ready, 2/2 — 19–22 dtk |
| 48 MB | di-kill 1/2, tidak ready dalam 90 dtk 1/2 | ready, 2/2 — 60–89 dtk |

**64 MB adalah batas bawahnya, untuk start pertama dan setiap start sesudahnya.** Di bawahnya start
pertama untung-untungan, dan start berikutnya baru sampai setelah semenit lebih membaca binary berulang
kali. Pada 64 MB sebuah start melakukan paging selama puluhan detik; pada 128 MB hanya beberapa detik.
Tanpa batas, puncak resident start pertama 98 MB dan memori anonimnya 37 MB lima detik setelah `ready`.

Sebelum 0.7.11 batas bawah start pertama adalah 112 MB, dengan start berikutnya di 64: password akun
di-hash dengan 64 MiB milik Bun, dan setiap kill terjadi di hash itu (di-kill di 96 MB, ready di 112 MB
dengan puncak 100,7 MB — hari yang sama, prosedur yang sama tetapi halaman binary dibiarkan di cache).
Dengan dashboard dimatikan (`[dashboard] enabled = false` — tanpa akun, jadi tanpa hash), start pertama
waktu itu pun mencapai `ready` di 48 MB. Di bawah Rosetta, linux-x64 bergerak dengan cara yang sama dan
lebih tinggi, dan belum dijalankan lagi sejak hash-nya diubah.

Build 2026-08-14 tercatat mencapai `ready` di 64 MB dan di-kill di 48 MB. Boot-nya juga membuat akun
(`ensureInitialAdmin`, di tree waktu itu di `71d6ba3`); kenapa waktu itu muat tidak diketahui — batas dan
direktori data run itu tidak dicatat selain tabelnya, dan run itu belum diulang.

**Runtime menyesuaikan diri dengan batas, bukan menuntut anggaran tetap.** Diberi 256 MB, start pertama
yang lama memuncak di sekitar 145 MB, dan start berikutnya menjalankan memori anonimnya di 25–28 MB di
bawah batas mana pun dari 48 sampai 128 MB. Jadi puncak boot bukanlah batas bawah; batas bawah adalah
titik di mana halaman binary, runtime, dan hash password berhenti muat bersamaan.

Jangan deploy di batas bawah.
Itu angka yang membuktikan daemon-nya kecil, bukan rekomendasi: pada 64 MB sebuah start memakan puluhan
detik, dan tidak ada sisa untuk sebuah turn.

## Terukur: agen hampir gratis

| Agent pack dimuat | Anonim, idle | Puncak boot |
|---|---|---|
| 1 | 27,3–27,5 MB | 145,6 MB |
| 3 | 28,2–28,4 MB | 146,8 MB |
| 6 | 29,1–29,2 MB | 146,9 MB |

linux-arm64, Docker di M1, 2026-10-17, dari 30 detik sampai satu menit setelah `ready`. Lewat Rosetta,
linux-x64: 58,0–59,8, 59,4–59,5 dan 62,6 MB.

**Kira-kira 0,4 MB per agen idle** — 0,34 MB dari satu ke enam di sini, sekitar 0,4 pada 2026-08-14. Agen yang dijawab model adalah direktori berisi markdown, bukan proses: prompt
dirakit per turn dan tidak disimpan di memori, dan setiap agen berbagi satu proses, satu database,
dan satu HTTP server.

Ini adalah angka untuk menghitung kapasitas saat menambah agen, dan ini bukan angka yang tepat untuk
menghitung pekerjaan *konkuren* — lihat di bawah.

Agen eksternal (0.8.1) lain ceritanya: yang menjawabnya adalah coding CLI, proses tersendiri sejak turn pertamanya
sampai lima menit setelah turn terakhirnya — beberapa ratus MB masing-masing, lihat di bawah.

## Terukur: coding CLI (0.8.1)

Memori yang dipegang satu coding CLI dengan sesi terbuka dan idle, sebelum mengerjakan apa pun — prosesnya dan setiap
proses yang dijalankannya. Diukur 2026-10-26 di macOS arm64, belum sign-in, saat 0.8.1 dibangun (`CLI_SESSION_BYTES`
di `apps/engine/src/modules/external-agents/index.ts`); bukan dengan prosedur Linux di [Menjaga dokumen ini tetap
akurat](#menjaga-dokumen-ini-tetap-akurat), dan tidak tercatat apakah angkanya memori resident atau anonymous.

| CLI | Dipegang saat idle |
|---|---|
| Claude Code (`claude-agent-acp`) | 324 MB |
| Codex (`codex-acp`) | 187 MB |

Sesi yang sedang bekerja memegang lebih banyak, dan itu belum diukur. **512 MiB adalah batas bawahnya, dibulatkan ke
atas dari yang lebih besar**: kalau ruang untuk perintah para agen kurang dari itu — batas cgroup mereka kalau ada,
selain itu memori mesin — `nouride agents scan` bilang begitu dan tidak ada CLI yang ditawarkan. Kalau perintah para
agen punya cgroup sendiri, daemon menyisakan seperlima mesin untuk dirinya, minimal 256 MiB dan maksimal 512
(`process-cgroup.ts`), jadi batas bawah itu butuh mesin 768 MiB — diturunkan dari aturan itu, bukan diukur. Setiap
agen eksternal menjalankan CLI-nya sendiri, jadi dua yang bekerja bersamaan memegang dua kali angka ini.

**Mission di sebuah repository** (0.8.1) bekerja di worktree sendiri hanya kalau perintah para agen punya 512 MiB
yang sama, dan disk yang kosong minimal dua kali ukuran file repository yang ter-checkout — satu salinan, dan sebanyak
itu lagi untuk dependensi yang diinstal ke dalamnya. Kalau salah satunya kurang, mission bekerja langsung di
repository, dan mission di satu repository berjalan satu per satu.

## Terukur: apa yang dilakukan daemon idle terhadap mesin

Di x64 test box, daemon live (6 agen, 9 gateway), dibaca sekali per menit dari `/proc/<pid>/io`,
`/proc/<pid>/task/*/status`, `/proc/<pid>/stat` dan counter interface jaringan selama 119 menit —
2026-10-17, 09:45 sampai 11:44 UTC, dalam dua run — ketika daemon tidak menjalankan turn, tidak memanggil model, tidak
melihat pesan room, dan tidak menulis baris log atau event, dicek terhadap database-nya sendiri setelahnya.
Tidak ada yang diubah di mesin itu untuk mengukurnya: `perf`, `strace` dan `fatrace` tidak terinstal di
sana, jadi context switch menggantikan `sched_wakeup`, dan byte yang ditulis adalah hitungan per proses
dari kernel.

| Apa | Terukur | Per hari |
|---|---|---|
| Byte yang ditulis (`write_bytes`; `wchar` kurang lebih sama) | 30 KiB dalam 119 menit, 6,7 panggilan write per menit | **sekitar 0,35 MiB, diekstrapolasi** dari jendela idle |
| Wake-up (voluntary context switch, semua thread) | median 635 per menit | — |
| … thread event loop | median 236 per menit — interface container menerima median 255 paket per menit, hampir semuanya dari koneksi daemon | — |
| … GC helper JavaScriptCore; scavenger mimalloc | median 240; median 142 per menit | — |
| CPU | 10 tick per menit (0,1 detik) — 0,17% dari satu core | — |

**Soal menulis, daemon hampir tidak melakukan apa pun selama tidak ada yang mengajaknya bicara**: buffer
log dan audit-nya hanya menjadwalkan flush ketika ada isinya, dan tidak ada yang ditulis ke database. Apa
yang ditulis sehari yang berisi percakapan tidak ada di tabel ini: baris setiap turn, pass memori malam
hari, dan snapshot database harian, yang hanya diambil di hari ketika ada yang ditulis — di mesin ini
berupa salinan 30 sampai 36 MB (delapan terakhir di `data/backups/db`). Angka hari seperti itu butuh
sehari yang berisi turn, disampling dengan cara yang sama.

**Soal bangun, yang membangunkannya adalah runtime dan jaringan, bukan timer daemon.** Thread event loop
bangun kira-kira sesering paket datang — gateway enam bot Discord, WhatsApp dan Telegram — dan dua thread
runtime, helper garbage collector dan scavenger allocator, bangun kira-kira sesering itu lagi jika
digabung. Timer milik daemon sendiri — health check per gateway setiap 30 detik, sleep cron, heartbeat,
jam pass memori — berjumlah sekitar dua puluh per menit di sini menurut interval-nya (diturunkan, bukan
diukur), sepersepuluh dari angka event loop. Mesin dengan satu bot Telegram dan tanpa tab dashboard
terbuka akan melihat jauh lebih sedikit paket; itu belum diukur.

---

## Belum diukur: turn di bawah beban

Semua di atas adalah keadaan idle, tanpa traffic LLM.
Puncak memori per turn **belum** diukur, karena membutuhkan kunci provider yang aktif dan
percakapan nyata.

Yang membatasinya adalah konfigurasi, jadi batas atasnya setidaknya bisa diketahui
(`config.example.toml`):

| Pengaturan | Default | Mengapa mempengaruhi memori |
|---|---|---|
| `tool_max_output_bytes` | 100 MB | Disk, bukan memori: batas file spill satu `exec`. Di memori paling banyak ~64KB plus kepala dan ekor ~96KB per call, berapa pun output-nya. |
| `max_tool_iterations` | 250 | Tool call dalam satu turn. 5–9999. Tabel `[llm]` milik agent menimpanya. |
| `max_conversation_turns` | 200 | Riwayat tersimpan per percakapan. |
| `max_context_ratio` | 0,8 | Porsi context window model yang diisi. |
| `max_tokens_per_turn` | 32000 | Ukuran respons. |

**Memori bertambah sesuai turn konkuren, bukan sesuai jumlah agen.** Queue diurutkan per percakapan
dan paralel antar percakapan, jadi sepuluh chat yang dijawab bersamaan berarti sepuluh konteks
dirakit secara bersamaan. Satu agen di sepuluh channel sibuk memakan lebih banyak dari sepuluh agen
di satu channel yang sepi.

*Penalaran, bukan pengukuran:* satu turn yang membaca file besar atau menjalankan `exec` yang
mencetak megabyte adalah kasus terburuk yang realistis, dan 10 MB output tool ditambah konteks yang
dirakit adalah bentuknya. Inilah mengapa rekomendasi adalah 512 MB, bukan 128 MB, dan angka ini
harus diganti dengan pengukuran saat pertama kali beban kerja nyata dijalankan.

---

## Memilih ukuran mesin

| Target | Keputusan |
|---|---|
| **Raspberry Pi 4 / 5** (1 GB+) | Nyaman. Gunakan `--target linux-arm64`. Pi 5 lebih dari cukup. |
| **VPS 512 MB manapun** | Cukup, termasuk dashboard. Tier termurah di kebanyakan provider. Tidak untuk agen eksternal: coding CLI butuh 512 MiB untuk perintah para agen saja ([Coding CLI](#terukur-coding-cli-081)). |
| **VPS 1 GB** | Rekomendasi. Headroom untuk output `exec` dan beberapa chat konkuren. |
| **Mini PC / NUC / laptop lama** | Berlebihan, dan tetap pilihan yang tepat jika agen melakukan pekerjaan infrastruktur — instalasi native bisa bertindak di host. |
| **NAS dengan Docker** (Synology, QNAP, Unraid) | Cukup. Cek `uname -m` untuk target: beberapa di antaranya arm64. |
| **Alpine / apapun berbasis musl** | Butuh build `-musl` **dan** `apk add libstdc++`. Lihat [DEPLOY.md](./DEPLOY.md). |
| **Kubernetes** | Lihat di bawah. |

Untuk Kubernetes, titik awal, bukan konfigurasi yang sudah di-tuning:

```yaml
resources:
  requests:
    memory: 128Mi     # dua kali batas bawah 64 MB: di sana start melakukan paging puluhan detik, di 128 hanya beberapa
    cpu: 50m          # 0,17% dari satu core saat idle, di x64 test box
  limits:
    memory: 512Mi     # mengakomodasi puncak boot dan turn dengan output tool besar
    cpu: "1"
```

Pantau puncak aktual sebelum memperketat `limits`.
Limit di bawah puncak boot menghasilkan OOM kill saat startup, yang terbaca sebagai crash loop tanpa
error di log daemon itu sendiri — proses tidak pernah berjalan cukup jauh untuk menulisnya.

---

## Dibandingkan dengan agent runtime self-hosted lain

Hanya konfigurasi **API-only** yang perbandingannya adil: Nouride tidak punya automasi browser dan
tidak mendukung model lokal, jadi angka manapun yang menyertakan keduanya mengukur sistem yang
berbeda.

| | Minimum | Catatan |
|---|---|---|
| **Nouride** | 64 MB, start pertama juga, terukur (2026-10-17); 512 MB direkomendasikan | Bun/JSC, satu proses, SQLite |
| **Hermes Agent** (API-only) | 1–2 GB | 4 GB dengan automasi browser aktif |
| **OpenClaw** | 2 GB, 4 GB direkomendasikan | 2–3 GB *per agen* di setup multi-agen; 16 GB untuk produksi |

Selisihnya kira-kira 20–30×, dan ini bersifat arsitektural, bukan hasil tuning:

- **Bun/JSC melawan Node/V8.** OpenClaw berjalan di Node, di mana batas heap default V8 sekitar
  1,5–2 GB dan mode kegagalannya adalah `JavaScript heap out of memory` — crash instan, bukan
  degradasi. Perilaku Nouride yang terukur di bawah tekanan adalah kebalikannya: diberikan 64 MB,
  start pertama juga, ia menyusut agar muat, menjalankan memori anonimnya di 25–30 MB.
- **Tanpa infrastruktur eksternal.** Tanpa Postgres, tanpa Redis, tanpa vector database — satu file
  SQLite. Satu-satunya dependensi non-workspace dari engine adalah `hono`.
- **Tanpa browser dan tanpa model lokal.** Inilah yang mendorong dua lainnya ke ranah gigabyte, dan
  Nouride tidak melakukan keduanya.
- **Agen adalah konfigurasi, bukan proses.** Terukur ~0,4 MB per agen idle dibandingkan 2–3 GB yang
  didokumentasikan OpenClaw. Kategori berbeda, bukan implementasi yang lebih baik dari hal yang sama. Pengecualiannya
  agen eksternal (0.8.1): coding CLI-nya adalah proses, 187–324 MB saat idle ([Coding CLI](#terukur-coding-cli-081)).

**Dua catatan penting.** Angka Nouride adalah pengukuran langsung di hardware yang disebutkan di atas;
angka perbandingan berasal dari panduan setup pihak ketiga dengan kualitas bervariasi, dan meskipun
semuanya sepakat soal skala — gigabyte, bukan puluhan megabyte — tidak satupun yang boleh dianggap
otoritatif. Dan sebagian selisih adalah **cakupan**: menambahkan automasi browser atau model lokal
akan langsung menempatkan Nouride di kelas yang sama.

Sumber: [Cherry Servers](https://www.cherryservers.com/blog/openclaw-hardware-requirements) ·
[TechRadar](https://techradar.com/pro/how-to-self-host-your-openclaw-environment-on-a-vps-server) ·
[Contabo](https://contabo.com/blog/how-to-install-hermes-agent-on-a-vps-2026-step-by-step-guide/)

---

## Automasi browser akan mengubah semua angka di sini

Tidak direncanakan, dan profil resource hanya alasan ketiga.

**Ini akan menghapus keunggulan terukur.** Sebuah instance Chromium memakan 300 MB hingga lebih dari
1 GB, yaitu empat hingga lima belas kali seluruh daemon. Rekomendasi 512 MB menjadi 2 GB, dan baris
Raspberry Pi di tabel di atas tidak lagi benar.

**Ini bertentangan dengan TD-001 dan minimalisme image.** Browser yang dikendalikan berarti binary
spesifik platform yang diunduh saat instalasi, dan container berjalan sebagai uid 1000 justru agar
tidak ada yang bisa menginstal apapun saat runtime — keputusan yang sudah diverifikasi dengan
melihat `apk add` gagal.

**Alasan keamanan-lah yang benar-benar menentukan.** Browser yang dikendalikan oleh model yang
mengambil instruksi dari pesan chat adalah mesin request serba guna di dalam batas jaringan. Guard
SSRF `web_fetch` ada karena tool itu pernah membaca layanan loopback dan menyerahkan body-nya ke
model, dan `allow_private_urls` default-nya `false` karena di server, agen yang bisa menjangkau
`127.0.0.1` bisa membaca setiap layanan internal di mesin tersebut. Automasi browser adalah lubang
itu yang dibuka kembali secara sengaja, dan headless browser tidak punya padanan dari approval gate
exec.

**Jika suatu saat diinginkan, tempatnya di luar proses.** Server MCP yang memiliki browser menjaganya
tetap di luar footprint daemon, di luar graf dependensi, dan di balik batas tool yang bisa ditolak
per agen — dan klien MCP sudah menjadi fase berikutnya, jadi ini tidak membutuhkan arsitektur baru.

> **2026-10-12:** dua pernyataan di atas sudah tidak berlaku. Sebuah skill bawaan, `browser-automation`,
> kini menjalankan headless browser di luar proses daemon — Playwright lewat `exec`, diinstal saat
> dibutuhkan di mesin yang punya Node — dan tidak ada angka di file ini yang menyertakannya: selama
> berjalan, browser itu memakan 300 MB hingga 1 GB seperti dijelaskan di atas, di luar daemon. Selain itu,
> user di dalam container kini bisa menginstal program saat runtime tanpa root, ke `.nouride/bin` di
> volume. Klien MCP yang disebut sebagai fase berikutnya di bagian ini sudah tersedia.
>
> **2026-11-03 (0.8.15):** paket sistem juga. User daemon tetap tidak bisa `apk add`: service root yang dijalankan
> entrypoint memasang paket berdasarkan namanya, dengan aturan tetap dan bertanya ke orang dulu kecuali agent-nya
> `trusted`, dan yang dipasang agent disimpan di volume lalu dipasang lagi saat container dibuat ulang.

Yang mencakup sebagian besar kebutuhan nyata saat ini: `web_fetch` untuk membaca halaman, dan
`allow_private_urls = true` untuk memeriksa layanan yang baru saja dijalankan agen. Celah yang
benar-benar tersisa adalah halaman yang me-render kontennya dalam JavaScript, yang tidak bisa dilihat
oleh fetch. Itu lebih sempit dari "kita butuh browser" dan layak dikonfirmasi terhadap tugas nyata
sebelum menginvestasikan apapun untuk itu.

---

## Menjaga dokumen ini tetap akurat

**Dokumen ini menjadi usang tanpa pemberitahuan.** Tidak ada yang gagal ketika dependensi, upgrade
runtime, atau cache resident baru menggeser angka-angka ini — daemon tetap bekerja dan file ini tetap
mengklaim 64 MB, seperti yang terjadi setelah start pertama mulai membuat akun dan membutuhkan 112 sampai 0.7.11. Maka
catatan provenance di atas mencantumkan tanggal dan apa yang diukur di mana, dan pengukuran ulang adalah
prosedur terdokumentasi, bukan tugas riset.

**Ukur ulang ketika salah satu dari ini berubah:**

- Versi Bun, atau dependensi apapun yang dimuat saat boot.
- Apapun yang disimpan resident per agen, per percakapan, atau per gateway — cache, registry, indeks.
- Apapun yang dialokasikan sekaligus oleh sebuah start atau sign-in — terutama parameter hash password.
- Batas atas di tabel di atas, terutama `tool_max_output_bytes`.
- Apapun yang menambahkan proses: browser, model lokal, sidecar, server MCP.
- Coding CLI bawaan, atau adapter tempat ia berjalan, di versi baru — untuk barisnya di bagian Coding CLI, dan batas
  bawah 512 MiB yang dibulatkan dari yang terbesar.

Kemudian perbarui angka-angka **dan** catatan provenance, di commit yang sama dengan perubahan yang
menggesernya.

Daemon yang berjalan menyebutkan memorinya sendiri: `/health` membawa `memory.rssBytes` dan
`memory.heapUsedBytes`, dan `nouride doctor` mencetaknya. Itu membaca mesin live tanpa shell di sana;
prosedur di bawah ini yang membuat dua build bisa dibandingkan.

```bash
# 1. Build artefak Linux.
bun run build:binary --target linux-arm64        # atau linux-x64 — lewat Rosetta di host Apple: lihat provenance

# 2. Footprint idle dengan satu agent pack, di dalam container Linux nyata.
#    Bukan di macOS: angka host berbeda, dan target deploy adalah Linux.
#    Pack contoh adalah template nonaktif yang menyebut profil `anthropic`, dan tidak ada profil bawaan:
#    diaktifkan dan diberi profil, pack itu termuat; seperti yang dikirimkan, run ini tidak mengukur agen apa pun.
docker run --rm --platform linux/arm64 \
  -v "$PWD/dist:/art:ro" -v "$PWD/content/agents:/packs:ro" debian:12-slim sh -c '
    mkdir -p /srv/nouride && cd /srv/nouride && tar -xzf /art/nouride-linux-arm64.tar.gz
    mkdir -p .nouride/agents && cp -R /packs/example .nouride/agents/example1
    sed -i -e "s/^name = \"example\"/name = \"example1\"/" -e "s/^enabled = false/enabled = true/" .nouride/agents/example1/config.toml
    printf "[providers.anthropic]\nkind = \"anthropic\"\nbase_url = \"https://api.anthropic.com/v1\"\napi_key = \"ANTHROPIC_API_KEY\"\n" > .nouride/config.toml
    ./nouride start > run.log 2>&1 & PID=$!
    sleep 12
    grep -o "\"count\":[0-9]*" run.log | head -1
    awk "/VmRSS|VmHWM|RssAnon|RssFile|Threads/{print \$1, \$2}" /proc/$PID/status'

# 3. Batas bawah: perintah yang sama dengan --memory=<batas> --memory-swap=<batas>, cek "nouride ready" di
#    run.log. Bisect ke bawah — runtime menyusut agar muat, jadi batas bawah adalah di mana boot gagal,
#    bukan di mana RSS berhenti. Dua kali: pada direktori data baru (start pertama, yang membuat akun
#    dashboard), dan pada direktori yang sudah dibuat start pertama (start berikutnya). Ekstrak dulu ke
#    sebuah volume dari container tanpa batas, agar container yang dibatasi hanya memegang daemon, bukan
#    page cache dari tarball 95 MB yang baru saja ditulisnya.
#    Dan buang halaman binary dari page cache sebelum setiap run yang dibatasi — kalau tidak, halaman itu
#    sudah dibaca, dan dibebankan, ke container sebelumnya, dan batasnya tampak lebih lega daripada start
#    dingin (`fincore` menyebut berapa yang ter-cache; 0 sebelum setiap run):
docker run --rm -v <volumenya>:/srv debian:12-slim dd if=/srv/nouride/nouride iflag=nocache count=0
docker run --rm --platform linux/arm64 --memory=64m --memory-swap=64m ...
```

`VmHWM` adalah puncak dan `VmRSS` adalah angka saat ini; keduanya dalam kB di `/proc/<pid>/status`, dan
`RssAnon` adalah bagian yang tidak bisa dibuang kernel. Sampling minimal satu menit sebelum menyebut angka
istirahat sudah datar — tujuan sampling adalah menangkap drift, dan satu pembacaan tidak bisa melakukannya.
