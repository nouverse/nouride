---
title: Konsumsi sumber daya
description: Berapa sebenarnya biaya menjalankan Nouride, terukur, lengkap dengan asal-usul tiap angka.
---

Setiap angka di halaman ini **diukur**, bukan dikira-kira. Apa pun yang berupa penalaran, bukan
pengukuran, ditandai sebagai penalaran.

:::note[Asal-usul]
Angka idle, batas bawah dan agent diukur ulang pada 2026-10-17, di branch 0.7.11: binary `linux-arm64`
yang berjalan di dalam `debian:12-slim` di host Apple M1, dan daemon live di satu mesin `linux-x64`,
dibaca tanpa mengubah apa pun. Angka edisi diukur di satu mesin `linux-x64`, angka sebelum/sesudah
`--smol` di dua mesin live, dan angka database di satu instalasi live saat upgrade-nya ke 0.7.0. Yang
itu lebih lama dan belum diambil lagi.

Ukuran bergerak mengikuti runtime. Ukur ulang sebelum memercayai angka ini terhadap build yang jauh
lebih baru; *selisih* antar baris adalah bagian yang bertahan.
:::

## Jawaban singkatnya

| | |
|---|---|
| **Batas bawah** | RAM 64 MB, start pertama juga. Diukur 2026-10-17, `linux-arm64`, dari page cache yang dingin. Di sana sebuah start makan puluhan detik |
| **Nyaman** | 512 MB. 1 GB kalau agent mengerjakan hal nyata lewat `exec`. Penalaran, bukan pengukuran |
| **Agent eksternal** | Satu CLI coding per agent sebagai tambahan, saat diam 324 MB untuk Claude Code dan 187 MB untuk Codex ([di bawah](#agent-eksternal)); gak ada kalau perintah agent kebagian di bawah 512 MiB |
| **Disk** | 95 MB terpasang, unduhan 40 MB. `data/` yang baru berukuran 364 KB (2026-08-14), dan tumbuh sesuai apa yang diingat |
| **CPU** | Apa saja. 0,17% dari satu core saat idle di mesin x64 dengan sembilan gateway tersambung, dan 0,18% dengan lima belas (diukur lagi 2026-11-08, selama dua menit); hampir sepanjang waktu ia menunggu jaringan |
| **Gak butuh** | Postgres, Redis, vector database, GPU, atau model lokal |

Gak ada syarat model minimum, karena Nouride gak menampung model. Provider adalah endpoint jarak
jauh, jadi RAM gak dipengaruhi model mana yang dipakai agent.

## Saat idle

Daemon diam, gateway tersambung, gak ada giliran berjalan. Memori resident adalah halaman binary, yang
dibuang kernel dan dibaca ulang saat memori sempit, dan memori anonim, yang gak bisa dibuang: hitung
kapasitas dari yang kedua.

| Bentuk | Resident idle | darinya, anonim | Puncak saat boot | Artefak |
|---|---|---|---|---|
| Binary terkompilasi, `linux-arm64`, 1 agent (2026-10-17) | 59,0–67,5 MB | **27,3–27,5 MB** | 145,6 MB | 94 MB terpasang |
| Daemon live, `linux-x64`, 6 agent, 9 gateway (2026-10-17) | 117–128 MB | 87–98 MB | tidak diukur | tidak diukur |
| Binary terkompilasi, macOS, 0 agent (2026-08-14) | 63,7 MB | tidak diukur | tidak diukur | 58 MB |
| Image Docker (2026-08-14) | 69 MB proses / 96 MB container | tidak diukur | 166 MB | 85 MB image |

Diambil sampel tiap 15 detik selama semenit setelah `ready`: memori anonim datar, 16 thread turun ke 5,
tanpa proses anak. Daemon live itu membawa enam bot Discord, sesi WhatsApp di dalam proses, Telegram dan
database 41 MB. Mesin yang sama terbaca 65,6 MB pada 2026-09-02 (tabel `--smol` di bawah); sejak itu bridge
WhatsApp pindah ke dalam daemon, dan indeks memori serta event stream ditambahkan.

**Puncak boot kira-kira dua kali angka diamnya**, dan itulah yang harus diakomodasi sebuah batas memori,
bukan angka diamnya. Pada start pertama, sebagiannya adalah hash password, 19 MiB sejak 0.7.11. Batas di bawah
puncak itu menghasilkan OOM kill saat startup, yang terbaca sebagai crash loop tanpa error di log daemon:
prosesnya gak pernah sempat menulis satu pun.

Binary dan image berjarak ~10 MB satu sama lain, jadi **jangan memilih di antara keduanya atas dasar
memori**. Pilihlah berdasarkan apakah agent harus bisa bertindak di host.

## Batas bawah

Dijalankan di bawah batas cgroup keras, diperiksa apakah daemon mencapai `ready`, pada start pertama,
yang membuat akun dashboard, dan pada start berikutnya. `linux-arm64`, 1 agent, dashboard menyala,
2026-10-17, setiap start dimulai dingin: halaman binary dibuang dari page cache sebelum setiap run, jadi
semua yang dibacanya dibebankan ke container yang dibatasi.

| Batas | Start pertama | Start berikutnya |
|---|---|---|
| 128 MB | ready, 2–5 dtk | ready, 1–3 dtk |
| 72 MB | ready, 4–11 dtk | ready, 3–14 dtk |
| **64 MB** | **ready**, setiap run, 9–68 dtk | **ready**, setiap run, 16–22 dtk |
| 56 MB | ready 2 dari 4, OOM 2 | ready, 19–22 dtk |
| 48 MB | OOM, atau gak ready dalam 90 dtk | ready, 60–89 dtk |

**64 MB, start pertama juga.** Sampai 0.7.11 start pertama butuh 112 MB: password akun baru di-hash
dengan argon2id pada biaya bawaan Bun, 64 MiB sekaligus, dan setiap OOM terjadi di hash itu. Sekarang
biayanya OWASP, 19 MiB, dan akun yang dibuat sebelumnya di-hash ulang dengan biaya itu saat pertama kali
sign-in.

**Runtime-nya menyesuaikan diri dengan batas, bukan menuntut anggaran tetap.** Start berikutnya
menjalankan memori anonimnya di 25–28 MB di bawah setiap batas dari 48 sampai 128 MB. Yang dibayar oleh
batas yang ketat adalah waktu: halaman binary dibaca berulang kali, jadi pada 64 MB sebuah start makan
puluhan detik, sementara 128 MB cuma beberapa detik.

Jangan deploy di batas bawah. Itu angka yang membuktikan daemon-nya kecil, bukan rekomendasi: pada
64 MB gak ada sisa untuk satu giliran pun.

## Agent nyaris gratis

| Pack agent termuat | Anonim, idle | Puncak boot |
|---|---|---|
| 1 | 27,3–27,5 MB | 145,6 MB |
| 3 | 28,2–28,4 MB | 146,8 MB |
| 6 | 29,1–29,2 MB | 146,9 MB |

**Kira-kira 0,4 MB per agent idle** (`linux-arm64`, 2026-10-17). Sebuah agent adalah direktori Markdown, bukan proses: prompt
dirakit per giliran dan gak ditahan di memori, dan semua agent berbagi satu proses, satu database dan
satu HTTP server. Agent eksternal pengecualiannya: CLI coding-nya adalah proses tersendiri ([di bawah](#agent-eksternal)).

Ini angka untuk menghitung penambahan agent. Ini angka yang **salah** untuk menghitung pekerjaan
serentak.

## Satu giliran di bawah beban

Gak diukur, butuh key provider aktif dan percakapan nyata. Yang membatasinya adalah konfigurasi, jadi
plafonnya setidaknya bisa diketahui:

| Pengaturan | Default | Kenapa memengaruhi memori |
|---|---|---|
| `max_concurrent_turns` | 8 | Giliran yang jalan sekaligus, di semua chat. Sisanya menunggu |
| `tool_max_output_bytes` | 100 MB | Output satu tool call. Yang besar dialirkan ke disk dan cuma kedua ujungnya yang ditahan |
| `max_tool_iterations` | 250 | Tool call dalam satu giliran |
| `max_conversation_turns` | 200 | Riwayat tersimpan per percakapan |
| `max_context_ratio` | 0,8 | Porsi jendela konteks model yang diisi |
| `max_tokens_per_turn` | 32000 | Ukuran respons |

**Memori naik mengikuti giliran serentak, bukan jumlah agent.** Antrean menjalankan chat secara
paralel, sampai delapan giliran sekaligus secara default, jadi delapan chat yang sibuk berarti delapan
konteks dirakit sekaligus. Satu agent di sepuluh channel sibuk lebih mahal daripada sepuluh agent di
satu channel sepi.

*Penalaran, bukan pengukuran:* satu giliran yang membaca file besar atau menjalankan `exec` yang
mencetak megabyte adalah kasus terburuk yang realistis. Itulah sebabnya rekomendasinya 512 MB dan bukan
128 MB.

## Database-nya

Satu file SQLite, dibuka dengan page cache 16 MB, sementara default SQLite 2 MB. Cache-nya cuma terisi
saat halaman dibaca, jadi database kecil gak pernah memakai semuanya. Pengurutan sementara disimpan di
memori, karena unit yang dikeraskan hampir gak punya tempat di disk untuk menulisnya.

Seberapa besar file-nya tergantung seberapa banyak yang diingat. Di satu instalasi live dengan 895
percakapan yang diingat, ukurannya **31 MB** setelah upgrade ke 0.7.0, dengan indeks kata kunci
4,7 MB di dalamnya. Sebelum itu, data yang sama makan 76 MB: dua pertiga file-nya adalah indeks kata
yang disimpan di tabel biasa, yang lalu digantikan mesin full-text milik SQLite sendiri. Setiap
snapshot mingguan adalah salinan file itu, jadi `daemon.backup_keep` melipatgandakannya di disk.

## `--smol`

Binary rilis dikompilasi dengan `--smol` tertanam di `execArgv`-nya, sehingga menjalankan heap lebih
kecil dan lebih sering mengumpulkan sampah. Diukur di dua mesin live, sebelum dan sesudah build yang
selain itu sama:

| | RSS sebelum | RSS sesudah | heap sebelum | sesudah |
|---|---|---|---|---|
| 6 agent, 9 gateway | 76,5 MB | **65,6 MB** | 48,6 MB | 41,4 MB |
| 1 agent, 2 gateway | 95,4 MB | **79,3 MB** | 46,4 MB | 33,2 MB |

Biayanya CPU: benchmark padat alokasi berbentuk sebuah giliran berjalan 21% lebih lambat. Itu pertukaran
yang tepat di sini, karena waktu sebuah giliran didominasi menunggu model dan bukan alokasi lokal,
tetapi `bun run build:binary --no-smol` membangun tanpanya untuk host yang memorinya berlebih.

## Edisi

Dua edisi dirilis, dan keduanya membawa WhatsApp di dalam binary.

| Edisi | Binary | Tarball | RSS idle | |
|---|---|---|---|---|
| Community *(default)* | 88,6 MB | 40,0 MB | 58,0 MB | Daemon-nya saja |
| Router | 88,9 MB | 40,2 MB | 59,7 MB | Community dengan Nougate di proses yang sama |

`RSS idle` di sini adalah daemon yang membawa kodenya dengan fiturnya **dimatikan**: biaya untuk
memiliki opsinya.

Binary dan tarball adalah build `linux-x64`, Community di 0.7.0 dan Router di 0.6.0. Angka RSS-nya
lebih tua dari nama edisinya: diambil pada bentuk build yang sekarang dimiliki edisi-edisi itu, dan
belum diukur ulang sejak itu. Ukuran bergeser mengikuti runtime Bun, jadi ukur lagi sebelum
mengandalkannya.

**Bundle yang gak kamu nyalakan gak gratis.** Import dinamis berarti kodenya gak pernah
*dieksekusi*, tetapi graf modulnya tetap terdaftar, itulah sebabnya build Community gak menyertakan
Nougate alih-alih mengandalkan import saja.

[Build & unduhan →](/id/docs/deployment/binaries/)

### Proses terpisah versus disematkan

| Komponen | Proses sendiri | Disematkan | Hemat |
|---|---|---|---|
| Bridge WhatsApp | 62,2 MB | +21,3 MB | **40,9 MB** |
| Gateway LLM (nougate) | 44,6 MB | +6,0 MB | **38,6 MB** |
| keduanya | 106,8 MB | +27,3 MB | **79,5 MB** |

Itu sebabnya bridge jalan di dalam daemon di setiap edisi, dan sebabnya edisi Router menjalankan
Nougate dengan cara yang sama. Kenapa hematnya sekitar 36 MB di keduanya: proses terpisah gak bisa
berbagi runtime Bun. Diukur dengan menjalankan satu binary dua kali: **~36 MB halaman runtime dan
bundle dibagi antar proses dari executable yang sama, dan ~14,5 MB heap bersifat privat untuk
masing-masing.** Jadi proses kedua membayar 36 MB itu lagi; listener kedua atau modul yang di-bundle
gak membayar sama sekali.

Kedua artefak terpisah itu hampir seluruhnya Bun: hello-world terkompilasi polos untuk `linux-x64`
berukuran 78,7 MB, jadi kode nougate sendiri cuma **0,3 MB** dari 79,0 MB-nya.

:::caution[Ukur di platform yang kamu kirim]
Salah satu perbandingan ini menunjukkan **+56,5 MB** di macOS di mana Linux menunjukkan +6,2 MB. Itu
soal akuntansi RSS, bukan biaya nyata, dan itu akan terbit sebagai fakta seandainya angkanya cuma
diambil sekali.
:::

## Memilih mesin

| Target | Penilaian |
|---|---|
| **Raspberry Pi 4 / 5** (1 GB+) | Nyaman. `--target linux-arm64`. Pi 5 lebih dari cukup |
| **VPS 512 MB apa pun** | Cukup, termasuk dashboard. Tier termurah di kebanyakan penyedia. Tanpa agent eksternal: satu agent eksternal butuh 512 MiB untuk perintah agent |
| **VPS 1 GB** | Rekomendasinya. Ada ruang untuk output `exec` dan beberapa chat serentak |
| **Agent eksternal** | 512 MiB untuk perintah agent sebelum satu pun ditawarkan, dan ruang untuk tiap CLI yang jalan bersamaan, satu per agent. `nouride doctor` menyebutkan berapa yang boleh dipakai perintah-perintah itu |
| **Mini PC / NUC / laptop lama** | Berlebihan, dan tetap pilihan yang tepat kalau agent mengerjakan infra |
| **NAS dengan Docker** | Cukup. Cek `uname -m`: beberapa arm64 |
| **Alpine / musl** | Butuh build `-musl` **dan** `apk add libstdc++` |

Untuk Kubernetes, titik awal, bukan jawaban yang sudah disetel:

```yaml
resources:
  requests:
    memory: 128Mi     # dua kali batas bawah 64 MB, di mana start cuma beberapa detik, bukan puluhan
    cpu: 50m          # 0,17% dari satu core saat idle
  limits:
    memory: 512Mi     # mengakomodasi puncak boot dan giliran dengan output tool besar
    cpu: "1"
```

Pantau puncak sebenarnya sebelum memperketat `limits`.

## Daemon sering bukan proses terbesar di cgroup-nya sendiri

Layak diketahui saat merencanakan mesin kecil. Di sebuah instalasi live, satu server MCP berbasis Node
terukur 91,5 MB, melawan 73,3 MB milik daemon. Di perangkat 256 MB, satu server itu yang menentukan
muat atau gaknya.

Begitu juga yang dijalankan agent. CLI coding agent yang jalan sebagai background job, atau browser
headless yang dikendalikan skill browser-automation, adalah proses sendiri yang dihitung di cgroup
yang sama: masing-masing beberapa ratus MB selama berjalan, menurut perkiraan skill-nya sendiri, bukan
pengukuran di sini.

## Agent eksternal

CLI coding milik [agent eksternal](/id/docs/manual/external-agents/) diukur dengan satu sesi terbuka dan diam,
sebelum mengerjakan apa pun, prosesnya beserta semua yang dinyalakannya (2026-10-26, macOS arm64, belum login):

| CLI | Diam dengan satu sesi terbuka |
|---|---|
| Claude Code | 324 MB |
| Codex | 187 MB |

Saat kerja lebih besar lagi. Masing-masing jalan satu per agent, dinyalakan di giliran pertamanya dan dimatikan setelah
lima menit diam, jadi beberapa agent yang menjawab bersamaan memegang memorinya sendiri-sendiri. Kalau perintah agent
kebagian di bawah 512 MiB (dibulatkan ke atas dari angka yang lebih besar), gak ada satu sesi pun yang bakal terbuka,
dan agent eksternal gak ditawarkan. Batas yang sama menentukan apakah misi di dalam repo dapat worktree sendiri.

## Kenapa sekecil ini

Bukan hasil penyetelan. Empat pilihan arsitektur:

- **Bun/JSC alih-alih Node/V8.** Di bawah tekanan memori, perilaku terukurnya adalah menyusut agar
  muat, bukan menabrak plafon heap lalu berhenti.
- **Tanpa infrastruktur eksternal.** Satu file SQLite. Daemon memakai empat paket pihak ketiga: satu
  untuk HTTP dan satu untuk tiap platform chat.
- **Tanpa browser di dalam proses dan tanpa model lokal.** Dua hal inilah yang mendorong runtime
  sejenis ke gigabyte.
- **Agent adalah konfigurasi, bukan proses.** 0,4 MB masing-masing, dan itu kategori yang berbeda, bukan
  implementasi yang lebih baik dari kategori yang sama.

Sebagian dari jarak itu adalah **cakupan**. Satu instance Chromium berukuran 300 MB sampai lebih dari
1 GB, empat sampai lima belas kali seluruh daemon, jadi otomasi browser gak ada di dalam daemon. Ia
hadir sebagai skill: agent mengendalikan browser headless lewat `exec`, di luar proses, jadi ia cuma
memakan memori selama berjalan, dan setiap langkahnya lewat gerbang approval yang sama dengan perintah
lain. Itu lebih penting daripada memorinya: browser yang dikendalikan model yang mengambil instruksi
dari pesan chat adalah mesin permintaan serbaguna di dalam batas jaringan kamu.
