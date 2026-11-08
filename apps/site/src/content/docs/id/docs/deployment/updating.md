---
title: Memperbarui
description: Mengecek apakah ada Nouride yang lebih baru, dan memasangnya, dari dashboard, CLI, atau oleh agent-nya sendiri.
---

Sebuah install bisa memberi tahu kamu kalau dia ketinggalan versi, dan kebanyakan bisa mengganti
dirinya sendiri. Yang mana punya kamu tergantung cara dia dikirim, dan daemon-nya yang menghitung
itu, bukan kamu.

```bash
nouride update --check
```

```
This install
  version      <current>
  edition      basic
  platform     linux/x64
  directory    @@INSTALL_DIR@@
  supervisor   systemd
  track        latest

✓ up to date: <current> is the newest release built for this edition.
```

Install yang tertinggal dapat bentuk yang lain, lengkap dengan nama artefak yang akan diambilnya:

```
↑ <current> → <latest>
  published    2026-09-15T05:54:36Z
  notes        https://github.com/@@GITHUB_REPO@@/releases/tag/<latest>
  artifact     nouride-linux-arm64
```

**Versi dan edisi barulah yang berarti "apa yang ter-deploy di sini".** Dua box dengan versi sama
bisa berbeda dalam hal gateway LLM ikut dikompilasi atau gak, dan bisa masuk dengan Nouverse atau gak,
jadi edisinya ikut ada di `/health`: `{"version":"<current>","edition":"basic",…}`.

## Rilis yang mana: jalur update

Sejak 0.8.18 sebuah install mengikuti salah satu dari dua jalur, diatur di halaman Update di
dashboard atau dengan `nouride update --track latest|lts`, dan disimpan sebagai `[update] track`
di `config.toml`:

- **`latest`**, bawaannya: setiap rilis begitu keluar, fitur baru bersama perbaikannya.
- **`lts`**: satu jalur jangka panjang, 1.0 yang pertama. Install di jalur yang lebih lama pindah ke
  sana lalu menetap, hanya mengambil perbaikannya. Selama belum ada jalur yang lebih baru di
  sampingnya, kedua jalur menawarkan hal yang sama.

`nouride update` menyebut jalur yang diikutinya, dan menyebut rilis jalur yang lain kalau berbeda:

```
  v1.1.0, new, is on the latest track; this install follows lts and stays on its line (`nouride update --track latest` moves it on)
```

Install Pro atau Box bertanya ke Nouverse, bukan ke mirror publik, dan Nouverse memilih di dalam
jalur yang sama.

## Mengambilnya

```bash
nouride update --start
```

Dari terminal, itu sudah seluruh perintahnya. Agent yang mengambil update menyertakan susulan yang
akan dia kerjakan saat kembali:

```bash
nouride update --start --then "pastikan versinya berubah dan semua gateway tersambung lagi"
```

Daemon mengunduh tarball untuk edisi **dan** platform-nya sendiri, mencocokkannya dengan checksum
milik rilis itu, menukar file-nya, dan menyimpan versi sebelumnya di `.nouride-previous/` di
sebelahnya.

Lalu ia **menunggu sepi**: restart terjadi begitu gak ada giliran yang jalan atau mengantre dan gak
ada approval yang menunggu, atau setelah sepuluh menit, mana yang lebih dulu. Giliran yang terpotong
saat itu menyimpan apa yang sudah dikerjakannya, dan agent melanjutkannya begitu daemon kembali.
Background job (build, test suite, run coding agent) ditunggu sampai selesai, berapa lama pun itu,
dan update-nya menyebutkan job mana yang sedang ditunggu. Service seperti dev server gak dihitung:
ia jalan sampai dihentikan, jadi menunggunya gak akan pernah selesai. `--now` langsung restart dan
menghentikan job-job itu. Pesan yang dikirim saat daemon sedang restart tetap dijawab begitu ia
kembali, selama dikirim dalam lima belas menit terakhir.

Semua ini gak butuh root. `install.sh` memberikan direktori install ke service user, jadi daemon
memang memiliki file yang ia ganti, dan ia restart dengan cara keluar supaya supervisor-nya menjalankan
binary yang baru, bukan dengan memanggil `systemctl`.

CLI melakukan kedua langkah dalam satu perintah. Dashboard memisahnya, karena di sana berguna bisa
mengambil rilisnya sekarang dan memasangnya nanti.

Turn susulannya **dibuat sebelum unduhan dan baru diaktifkan saat restart terjadi**. Urutan itu bukan
hiasan: di Raspberry Pi unduhannya makan sekitar 35 detik, jadi susulan yang jamnya mulai sejak
dibuat malah menyala *di tengah pembaruan*, mati kena restart, dan karena sekali-pakai ya hilang.
Selama belum diaktifkan ia diparkir lima belas menit ke depan, itulah kapan kamu diberi tahu kalau
ternyata penukarannya yang membunuh prosesnya.

:::caution[`--then` itu wajib buat agent, dan bukan formalitas]
Restart mengakhiri percakapan tempat perintah ini dijalankan, jadi giliran yang menjalankannya gak
akan pernah bisa mengecek hasilnya. Turn susulannya dibuat **sebelum** apa pun disentuh, jadi daemon
yang kembali dalam keadaan salah tetap disambut oleh yang memintanya, dan yang gak kembali sama sekali
akan disambut begitu dia kembali. Orang yang duduk di terminal mengawasinya sendiri dan gak butuh
apa-apa lagi; `--no-then` menyatakannya secara eksplisit.
:::

## Kalau versi baru gak mau jalan

Versi sebelumnya kembali dengan sendirinya. Versi baru masih dalam masa percobaan sampai ia
membuktikan dirinya: satu gateway chat tersambung, kalau ada, dan satu pesan sudah ditangani, atau
lima menit menyala di install yang memang gak punya apa-apa untuk ditangani. Sampai saat itu, penjaga
start di unit menghitung jumlah start-nya, dan di start keempat ia mengembalikan `.nouride-previous`
lalu menjalankannya. Penjaga ini ada di unit yang ditulis installer, di luar binary, karena binary baru
yang langsung crash gak bisa menyelamatkan dirinya sendiri. Versi yang jalan sesudahnya mencatat apa
yang terjadi di log.

## Kalau versi barunya salah

Versi yang berhasil jalan lalu berulah sudah lolos dari penjaga, jadi kembali ke versi sebelumnya
cukup satu perintah, dijalankan dengan daemon berhenti:

```bash
nouride update --rollback            # apa yang akan dilakukannya, tanpa mengubah apa pun
nouride update --rollback --apply    # lakukan
```

Perintah ini mengembalikan build yang disimpan, dan menyimpan build ini di tempatnya, jadi perintah
yang sama di versi lama akan maju lagi. Kalau update-nya memigrasi database, binary lama akan menolak
skema yang lebih baru, jadi database ikut kembali, ke snapshot yang diambil migrasi itu. Apa yang
terjadi sesudahnya hilang, dan perintah pertama mengatakannya, lengkap dengan waktunya, sebelum apa pun
disentuh. Database yang digantikan disisihkan di sebelahnya, jadi rollback-nya sendiri bisa dibatalkan.
Versi yang kamu tinggalkan gak akan diambil lagi oleh update otomatis.

Kalau kembali ke versi sebelum 0.8.19, yang cuma bisa membaca secret sebagai `secrets.json`, secret-nya ikut kembali
dalam bentuk itu, dengan mode `0600`; penyimpanan yang terenkripsi tetap ada di sebelahnya, dan 0.8.19 mengenkripsi lagi
`secrets.json` yang lebih baru saat ia kembali, beserta apa pun yang diubah versi lama itu. Langkah ini membuka
penyimpanannya, jadi di Linux jalankan sebagai root (`sudo nouride update --rollback --apply`): kunci penyimpanan
adalah file milik root, dan launcher-nya yang menyerahkannya. Tanpa kunci itu, perintahnya bilang begitu dan gak
mengubah apa pun.

Kalau kembali ke versi sebelum 0.8.19 dengan cara lain, misalnya lewat `install.sh` milik versi itu, keluarkan dulu
secret-nya, sebagai root:

```bash
sudo nouride secret decrypt --out /tmp/secrets.json
# hentikan Nouride, pindahkan /tmp/secrets.json ke .nouride/data/secrets.json (milik service account, 0600),
# lalu pasang versi itu
```

`install.sh` juga menyimpan build yang digantikannya, jadi ini berlaku setelah upgrade jenis apa pun.
Build simpanan yang disisihkan oleh versi lain (`install.sh` lama, binary yang disalin manual) ditolak:
itu bukan build sebelum versi ini.

## Dari dashboard

Bagian atas **Home** punya badge di sebelah **Restart**, *Up to date*, atau versi yang sedang
menunggu. Itu pintunya: menekannya membuka halaman **Update**, yang berupa kartu di Settings dan bukan
entri menu, karena memperbarui itu sesuatu yang jarang dilakukan dan hanya kalau memang ada yang perlu
dilakukan.

**Your box**, di bagian bawah sidebar, menampilkan versi yang sedang jalan, dan sebuah tombol yang
membuka Update kalau ada yang lebih baru. Versi di bawah wordmark juga dapat titik kecil saat itu.
Titik itu sinyal, bukan pintu: brand-nya menuju Home, dan badge atau tombol tadi yang ditekan.

![Halaman Update: versi dan edisi yang jalan di kiri, dan rilis terbaru untuk edisi itu di kanan](/media/dashboard-update.png)

Semua yang dibutuhkan untuk mempercayai halaman ini ada sekaligus: apa yang sedang jalan, edisinya
apa, platformnya apa, letaknya di mana, dan apa yang mengawasinya, lalu di sebelahnya, rilis
terbaru **untuk edisi ini**, bukan tag terbaru.

Halamannya mengecek setiap kali dibuka. Ada tombol **Check again** untuk yang gak sabar, lalu dua
langkah:

1. **Download.** Mengambil rilisnya dan mencocokkannya dengan checksum milik channel. Gak ada yang
   sedang jalan disentuh. Bisa **di-pause** dan dilanjutkan dari tempatnya berhenti, satu rilis
   puluhan megabyte dan di koneksi rumahan itu penantian yang nyata, atau dibuang sekalian.
2. **Install and restart.** Baru aktif setelah unduhannya selesai. Menukar binary-nya lalu
   me-restart daemon, dengan menunggu sepi seperti di atas.

Dua langkah yang bertindak masing-masing bertanya dulu, dan tiap konfirmasi menyebut apa yang
dilakukan *langkah itu*. Dipisah karena konsekuensinya memang beda: mengunduh memakan bandwidth dan
disk, memasang memakan daemon-nya.

Hanya admin yang bisa mengunduh atau memasang.

## Memperbarui container

Container **gak** diperbarui dari dalam dirinya, dan halamannya akan mengatakan itu alih-alih
menawarkan tombol. Itu bukan keterbatasan, itu memang hakikat container. Daemon-nya *bisa* saja
mengganti binary-nya sendiri di writable layer, restart, dan jalan; lalu begitu container-nya dibuat
ulang, deploy berikutnya, `compose up` berikutnya, node drain berikutnya, image-nya mengembalikan
versi lama. Versi yang diam-diam mundur lebih buruk daripada versi yang gak pernah berubah.

![Halaman Update di sebuah container: "<current> cannot be installed from here", berikut perintah compose, docker dan kubectl yang memang bekerja](/media/dashboard-update-container.png)

Perhatikan yang **gak** dilakukan halaman ini: gak ada tombol mati, gak ada angkat tangan.
Penolakannya menyebutkan alasan mana yang berlaku untuk install ini, dan mengembalikan perintah yang
bekerja, mirip dengan yang di bawah ini (dengan tag versi yang persis, bukan `latest`).

Jadi image-nya diganti dari luar:

```bash
# di direktori tempat compose file kamu
docker compose pull && docker compose up -d
```

Untuk kebanyakan orang itu sudah selesai: compose file-nya sudah menyebut image-nya, jadi gak ada
tag yang bisa salah.

Kalau manual, tarik image-nya lagi lalu buat ulang container-nya dari image itu, dengan flag yang sama
seperti saat pertama dijalankan:

```bash
docker pull @@DOCKER_IMAGE@@
docker rm -f nouride
docker run -d --name nouride ... @@DOCKER_IMAGE@@
```



`docker pull` selalu menanyakan digest di balik `latest` ke registry, jadi ia mengunduh tepat saat ada
yang baru, dan hanya layer yang berubah: runtime dan paket sistem di bawahnya tetap seperti semula.
Volume menyimpan semuanya; membuat ulang container gak menghilangkan apa pun.

Tiap edisi punya image sendiri. Container Router diperbarui dari `@@DOCKER_IMAGE@@-router`: kalau
di-pull dari `@@DOCKER_IMAGE@@`, ia kembali sebagai Community, tanpa gateway yang diharapkan
config-nya.

Di Kubernetes, dengan `imagePullPolicy: Always` di container-nya, restart menarik `latest` yang baru:

```bash
kubectl rollout restart deploy/<name>
```

## Dari versi yang lebih lama

Dari 0.7.x: lihat [Upgrade ke v0.8](/id/docs/deployment/upgrading-to-0-8/), yang menjelaskannya langkah demi langkah.

Versi ini cuma mau start di atas data yang sudah pernah dijalankan 0.8.0. Di 0.7 mulai 0.7.11,
`nouride update` dan halaman Update menawarkan rilis yang harus dilewati dulu sambil menyebut alasannya
(0.7.x terbaru kalau masih lebih lama dari 0.7.28, lalu 0.8.0), dan versi ini setelah 0.8.0 sempat start.
Selain itu (0.6, 0.5, 0.7 yang lebih awal, container) pasang secara manual, masing-masing start sekali:
0.7.29 kalau belum di 0.7.28 atau 0.7.29 (`--version v0.7.29` ke installer; dengan Docker, jalankan image
dengan tag `0.7` sekali di volume yang sama), lalu 0.8.0 (`--version v0.8.0`; tag `0.8.0`, bukan `0.8`,
yang sekarang sudah versi ini). Baru update ke versi ini.

Start 0.7.x terakhir membawa database, vault memory, `config.toml` dan pack setiap agent ke bentuk
terakhir 0.7 di disk, setelah snapshot, dan start 0.8.0 membawa database dan pack-nya ke bentuk sekarang.
Dari 0.6 atau 0.5, yang pertama itu artinya, dalam beberapa detik:

1. **Membuat snapshot database** sebagai `data/backups/db/nouride-<time>-before-048.db`, yang disimpan
   di luar rotasi harian, lalu memperbarui skema dan membangun ulang indeks memory dari vault kamu.
2. **Memindahkan halaman harian ke folder per bulan**, setelah vault kamu di-backup.

Kalau di-start di atas data yang belum pernah dijalankan 0.8.0, versi ini menolak sebelum menulis apa
pun dan menyebut jalannya: `install 0.8.0 first`, ditambah 0.7.x terakhir sebelumnya kalau datanya lebih
lama dari 0.7.28 atau halaman harian vault-nya masih di satu folder. Bentuk lama yang muncul lagi belakangan, di pack yang disalin dari tempat
lain atau hasil edit tangan, ditolak di tempat ia dibaca sambil menyebut apa yang harus ditulis: di
`config.toml` daemon gak start, di pack agent itu gak dimuat, dan di command line perintahnya keluar
dengan kode 2. `nouride config check` menyebut yang ada di `config.toml` dan setiap agent yang gak akan
dimuat.

| Bentuk lama | Tulis ini | Ditolak di |
|---|---|---|
| `[security] sender_allowlist` | `[security.access] allowlist` | `config.toml` |
| `[session_memory]` | `[rollover]` | `config.toml` |
| `[daemon] default_agent` | `[daemon] orchestrator` | `config.toml` |
| `[[people]] id` | `ids = ["platform:akun", …]` | `config.toml` |
| Akun di `[[people]]` beserta koneksinya (`telegram:nouva:814`), `local:…`, `web:dev` | `telegram:814`, `web:…`, `web:terminal` | `config.toml` |
| `[rsi]` | `[skills.learning]`, `mode = "ask"` atau `"auto"` | `config.toml` |
| `approvals = "normal"`, `"risky"`, `"none"` | `"careful"`, `"balanced"`, `"trusted"` | `config.toml`, pack |
| Telegram `mode = "webhook"` | tanpa `mode`: Telegram pakai polling | `config.toml` |
| `bridge_transport = "stdio"`, `bridge_command` | gak usah dua-duanya: bridge jalan di dalam daemon | `config.toml` |
| `exec_secrets = ["NAMA"]` | `[security.exec_secrets] NAMA = ["perintah yang memakainya"]` | pack |
| `memory_recent`, `task_plan` di daftar tool | `memory_search`, `plan` | pack |
| `[[mcp_servers]]` | library: `nouride mcp add` | pack |
| `[llm] fallback_model = "x"` | `fallbacks = [{ provider = "…", model = "x" }]` | pack |
| `--isolated` | `--session isolated` | CLI |
| `--token-stdin`, `--key-stdin`, `--value-stdin` | `--stdin` | CLI |
| `approvals approve`, `people forget` | `approvals allow-once`, `people remove` | CLI |
| `POST /approvals/<id>/approve` | `POST /approvals/<id>/allow-once` | control API |

Tiga dibaca dengan cara lain alih-alih ditolak: baris `Role:` di `IDENTITY.md` sebuah pack bukan
headline-nya (`Headline:` yang iya), `USER.md` di pack gak dibaca, dan `/auto` di chat jadi pesan biasa
untuk agent (`/approvals` perintahnya).

Beberapa kunci cuma diperingatkan lalu diabaikan, karena isinya memang nilai yang dipakai hampir semua
instalasi: `[health]`, `[cron] tick_interval_ms`, `[queue] dedup_window_ms`, dan tabel `[resilience]`
sebuah gateway sekarang [nilai tetap](/id/docs/reference/config/#nilai-tetap-sejak-080). Salinan
`config.example.toml` yang lama memuat tiga yang pertama: hapus baris yang disebut `nouride config check`.
Kunci yang gak dibaca `config.toml` sebuah pack disebut dengan cara yang sama, dan agent-nya tetap jalan.

**Sekali, opsional:** install binary yang di-update dengan `nouride update` tetap memakai unit lamanya,
yang membunuh perintah yang sedang jalan di awal restart alih-alih membiarkannya menyelesaikan
langkahnya, dan tetap menaruh `nouride` di `PATH` sebagai link yang dijalankan root secara langsung.
Jalankan ulang installer sekali untuk membereskan keduanya; `nouride doctor` terus mengingatkan sampai
itu dilakukan. Dengan Docker, tambahkan `stop_grace_period: 45s` ke compose file kamu.

**Kembali ke 0.6.7** butuh 0.7.29: `db restore` miliknya untuk snapshot `…-before-048.db` juga
mengembalikan halaman harian ke tempat yang diharapkan 0.6.7. Versi ini menolak me-restore snapshot
dari sebelum 0.8.0.

**Folder capture yang ditulis 0.5 dan 0.6** (`.nouride/memories/` secara default) gak dibaca, dan versi
ini gak punya impor untuknya. Kalau isinya yang lebih tua dari turn log mau disimpan sebagai memory,
impor dengan `memory backfill` milik 0.7.29 sebelum update; kalau gak, hapus saja foldernya.

## Paket sistem

Mengizinkan agent memasang [paket sistem](/id/docs/deployment/system-packages/) adalah pilihan yang
dibuat lewat installer sebagai root (`--allow-packages`), karena update jalan sebagai user milik daemon
dan gak bisa memasang service root. Sekali dinyalakan, fitur ini tetap nyala di setiap update.

Di Docker fitur ini nyala di image Nouride (0.8.15), dan update mempertahankan yang sudah dipasang agent: daftar dan
paket yang sudah diunduh ada di volume, di `.nouride/system-packages`, dan dipasang lagi sebelum daemon di container
yang baru jalan.

## Rilis baru jadi update kalau memang dibangun untuk kamu

Bagian ini layak dibaca dua kali, karena alternatifnya adalah sebuah install ditawari sesuatu yang
gak akan pernah bisa dia dapat.

Tiap edisi dibangun dan diterbitkan terpisah. Channel publik menerima tarball edisi **Community** dan
**Router** dan gak yang lain, jadi sebuah rilis bisa ada tanpa ada untuk build kamu. Yang di-resolve
daemon karenanya bukan "tag terbaru", melainkan **rilis terbaru yang benar-benar membawa build untuk
edisi ini, dan yang file checksum-nya mencakupnya**.

Jadi rilis yang hanya dibangun untuk edisi lain bukan update untuk install Community. Ia tetap
dilaporkan, berikut alasannya. Tag di bawah ini cuma perumpamaan, bukan rilis sungguhan:

> `<latest>` exists and is not an update here: it carries no build for the basic edition on
> linux/x64.

Dua-duanya disengaja. Gak menawarkannya adalah yang mencegah unduhan gagal; menyebut bahwa ia ada
adalah yang mencegah pengecekannya terlihat rusak.

## Install yang gak bisa memperbarui dirinya sendiri

Yang berikut ini gak bisa, dan masing-masing diberi tahu apa yang bisa:

| Install ini | Kenapa gak | Yang dijalankan |
|---|---|---|
| Container | Image diganti dari luar. Tukar-menukar di dalam hilang saat container dibuat ulang | `docker compose pull && docker compose up -d` |
| Direktori install yang gak bisa ditulis daemon | Ia mengganti file-nya sendiri, dan di sini gak bisa | installer lagi, sebagai root |
| Gak ada yang mengawasi | Tukarnya berhasil dan gak ada yang menjalankannya lagi, itu berhenti, bukan pembaruan | jalankan `nouride service install` dulu |
| Edisi Pro tanpa lisensi | Hanya memasang rilis bertanda tangan, yang datang dari channel yang didapat box atau server berlisensi dari Nouverse, bukan channel publik | box: pair dulu; server: install pakai link dari Nouverse, lalu cek lagi |
| Checkout source | Gak ada binary yang bisa diganti | `git pull`, `bun install`, `bun run build:binary` |

Penolakannya selalu membawa perintahnya. "Gak" yang harus kamu riset sendiri adalah "gak" yang
memakan satu sore.

## Agent-nya bisa melakukannya

Agent yang memegang tool `update` bisa mengecek tanpa diminta dan meminta izin untuk memasang:

- **`check` sama sekali gak digerbangi.** Membaca nomor versi gak mengubah apa pun, dan agent
  yang harus menginterupsi kamu untuk menjawab "kita sudah paling baru belum?" adalah agent yang
  gak pernah ditanya.
- **`apply` ada di daftar tetap** (`replace`): ditanyakan **setiap kali** di `careful`, yang ditulis untuk
  instalasi baru, dan gak pernah bisa jadi `allow-always` permanen. `balanced` menjawabnya sendiri; yang
  masih ditanyakan tingkat itu adalah daemon ini *dihentikan*, bukan diganti. Kalau gak ada yang bisa ditanya
  dan tingkatnya gak menjawabnya, ia ditolak, bukan dijalankan.

Agent menjadwalkan turn susulannya sendiri sebelum restart, jadi dia sendiri yang melapor:

> Sudah update ke <latest>; versi sebelumnya ada di `.nouride-previous`. Restart begitu gak ada lagi
> yang sedang jalan.

…lalu, dua puluh detik setelah restart, di percakapan yang sama:

> Sudah kembali di <latest>. Telegram dan WhatsApp dua-duanya tersambung lagi.

## Versinya dari mana

`@@DOWNLOAD_DOMAIN@@` mengarahkan ke repositori rilis publik, dan tag terbaru dibaca dari releases
API-nya, tanpa token, dan gak ada apa pun tentang install kamu yang dikirim. Jawabannya dipakai ulang
selama lima menit, karena API itu cuma mengizinkan enam puluh permintaan per jam tanpa token; **Check
again** langsung bertanya saat itu juga. Tarball diambil dari tempat yang sama dengan tempat
`install.sh` mengambilnya.

Daemon di belakang proxy yang gak mengizinkannya keluar akan mengatakannya (`could not reach the
release channel`), bukan melaporkan bahwa semuanya sudah paling baru.

## Yang diperiksa sebelum apa pun berpindah

- **Checksum-nya**, terhadap file checksum milik rilis itu (`CHECKSUMS`, atau `CHECKSUMS-router`; `SHA256SUMS…` sampai 0.7.x),
  sebelum satu file pun disentuh. Unduhan terpotong tetap bisa di-untar; binary yang gak jalan baru
  ketahuan setelah yang lama hilang.
- **Tanda tangan, untuk edisi Pro.** File checksum-nya harus ditandatangani dengan key yang
  dikompilasi ke dalam binary. Channel publik gak menerbitkan tanda tangan, jadi Community dan Router
  mengandalkan checksum dan HTTPS.
- **Bahwa tarball-nya memang berisi executable `nouride`.**
- **Bahwa artefaknya memang ada.** Edisi yang tarball-nya gak diterbitkan diberi tahu saat
  *pengecekan*, bukan saat sudah mencoba mengambilnya.

Penukarannya pakai rename, bukan copy, atomik, dan diizinkan menimpa executable yang sedang jalan,
yang mana copy gak bisa. Kalau satu gagal, yang sudah terlanjur dikembalikan.
