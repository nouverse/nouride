---
title: Kalau belum jalan
description: Kegagalan yang benar-benar dialami instalasi baru, dan apa penyebab sebenarnya.
---

Mulai dari sini:

```bash
nouride doctor
```

Ia memeriksa hal-hal yang biasanya menghentikan instalasi baru, provider tanpa kredensial, agent pack
yang gagal dimuat, gateway yang tersangkut reconnect, gak ada agent yang aktif sama sekali, dan
setiap temuan menyebutkan apa yang harus dilakukan. Exit code-nya bukan nol kalau ada masalah nyata,
jadi bisa dipakai di dalam healthcheck.

[Apa saja yang diperiksa doctor →](/id/docs/cli/doctor/)

---

## Instalasi

| Yang kamu lihat | Biasanya karena |
|---|---|
| `unsupported architecture` | ARM 32-bit. Kamu butuh OS 64-bit, lihat [Raspberry Pi](/id/docs/start/install/#raspberry-pi-dan-orange-pi) |
| Binary "not found" di Alpine padahal filenya ada | musl versus glibc, atau `apk add libstdc++` yang belum dipasang |
| `download failed` | Belum ada rilis di URL itu. Build sendiri lalu pakai `--tarball`, atau `--repo` untuk menarik dari GitHub releases |
| Instalasi selesai tapi `nouride` bukan perintah | `/usr/local/bin`, tempat launcher-nya ditaruh, gak ada di `PATH` kamu. Jalankan dengan path penuh: `@@INSTALL_DIR@@/nouride status`. Di Mac, installer cuma membuat link kalau bisa menulis ke `/usr/local/bin` atau `~/.local/bin` sudah ada: jalankan `~/nouride/nouride status`, atau buat `~/.local/bin` (yang ada di `PATH`) lalu jalankan installer lagi |
| `Permission denied reading …/.control-token` | Installer menambahkan kamu ke grup `nouride`, yang baru berlaku di login berikutnya. Jalankan `newgrp nouride`, atau `sudo nouride …` |
| `doctor` memperingatkan bahwa restart membunuh perintah yang sedang dijalankan sebuah giliran | Unit service-nya dari sebelum 0.7. Jalankan ulang installer sekali: unit-nya ditulis ulang dan `.nouride/` dibiarkan apa adanya |

## Menjalankan

**Service naik tapi `/health` gak pernah menjawab.** Daemon menolak config-nya dan keluar *setelah*
systemd melaporkan sukses. `systemctl start` yang mengembalikan 0 berarti prosesnya di-spawn, bukan
berarti ia sudah melayani.

```bash
sudo journalctl -u nouride -n 50 --no-pager
tail -n 50 ~/nouride/.nouride/data/nouride.log    # di Mac
```

**Daemon menolak start: "this release upgrades only from 0.8.0".** Datanya terakhir dijalankan 0.7.x, dan 0.8.1 cuma
mau start di atas data yang sudah pernah dijalankan 0.8.0. Gak ada yang ditulis. Install 0.8.0, start sekali, lalu
versi ini lagi. Dari yang lebih lama dari 0.7.28, 0.7.29 sekali sebelum itu; di Docker, tag `0.8.0` sekali di volume
yang sama. Pesan penolakannya bilang hal yang sama. Snapshot dari sebelum 0.8.0 juga ditolak `nouride db restore`
dengan cara yang sama: "install 0.8.0 first".
[Upgrade ke v0.8 →](/id/docs/deployment/upgrading-to-0-8/)

**`/health` bilang `starting` lama sekali.** Daemon yang sedang boot menjawab sejak detik pertamanya,
dengan 503 dan langkah yang sedang dikerjakan di `phase`: `checking the database` pada database besar
setelah crash, `connecting MCP servers` saat sebuah server lambat start (boot menunggu sepuluh detik per
server, lalu lanjut dan membiarkannya bergabung belakangan), `connecting gateways`. `nouride status` dan
dashboard mengatakan hal yang sama. Langkah yang gak bergerak adalah tempat untuk dicari di journal.

**`nouride status` bilang gak ada daemon padahal jelas jalan.** Selama setup belum menulis config,
CLI menentukan lokasi instalasi relatif terhadap direktori kerja kamu, jadi dari `/tmp` ia mencari
`/tmp/.nouride/data/.control-token`. Pesan error-nya menyebutkan path yang dicari, dan itu cara
tercepat mengenalinya. Jalankan dari direktori instalasi, atau set `NOURIDE_URL` dan `NOURIDE_TOKEN`.

**`nouride restart` menolak.** Dari terminal gak perlu flag apa pun; cuma agent yang diminta
`--then "<tindak lanjut>"`. Kalau jawabannya *nothing would restart this daemon*, gak ada yang
mensupervisinya: restart meminta daemon keluar supaya
supervisor-nya menghidupkannya lagi, dan tanpa supervisor itu cuma berarti berhenti, jadi ia menolak; `--force` tetap menghentikannya. `nouride service
status` menyatakan dengan jelas apakah ada yang bakal menghidupkannya lagi.

## Menjangkau dashboard

| Yang kamu lihat | Biasanya karena |
|---|---|
| Gak bisa dijangkau dari mesin lain | Bind ke loopback secara default. Jalankan ulang installer dengan `--host 0.0.0.0`, atau buat tunnel: `ssh -L @@PORT@@:127.0.0.1:@@PORT@@ kamu@host` |
| Port Docker yang dipublikasikan gak mencapai apa pun | `HOST` diatur ke alamat loopback, sering di `.env`. Image-nya bind ke semua interface kecuali diminta lain; container yang bind loopback berarti bind loopback *miliknya sendiri* |
| Halaman muncul tapi semua aset 404 | Direktori `dashboard/` gak ada di sebelah binary. Keduanya selalu bersama, pasang ulang dari tarball, jangan menyalin satu file saja |
| Password pertama terlewat | Cuma ditampilkan sekali. Di Mac masih ada di `~/nouride/.nouride/data/nouride.log`. Selain itu, hentikan daemon dan jalankan `sudo nouride users reset` (di Mac tanpa `sudo`); start berikutnya mencetak yang baru ([menyalakan pertama kali](/id/docs/start/first-run/#cari-password-pertama)). Set `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` di `.env` sebelum start pertama supaya gak terulang |

## Agent gak menjawab

**Sama sekali gak ada respons, di semua tempat.** Gak ada agent yang berjalan. `nouride agents`
menampilkan apa yang termuat dan dalam keadaan apa; pack yang gagal di-parse dilaporkan
`nouride doctor` lengkap dengan error-nya.

**Satu agent gak termuat setelah upgrade.** `nouride doctor` dan `nouride config check` menyebutkan pack dan
barisnya; agent lain tetap termuat. Ada dua yang baru di 0.8.1: `[llm] fallback_model`, yang sudah ditulis ulang 0.8.0
tapi muncul lagi dari git atau editan tangan (tulis `fallbacks = [{ provider = "…", model = "…" }]` sebagai gantinya,
seperti kata error-nya), dan kata di `[look]` yang bukan salah satu kata bagiannya, di mana error-nya menyebut kata apa
saja yang diterima bagian itu.

**Menjawab di dashboard tapi gak di aplikasi chat.** Entah koneksinya tersimpan tapi daemon belum
restart, adapter dibangun saat boot, atau pengirimnya belum diizinkan masuk. Periksa
`nouride gateway` untuk koneksinya dan `nouride access` untuk orangnya.

**Menjawab di DM tapi mengabaikan grup.** Di Telegram, privacy mode menyala: `/setprivacy → Disable`
di BotFather, atau jadikan bot admin. Kalau beberapa bot kamu ada di grup yang sama, pesan harus
menyebut salah satunya. Kalau bukan itu, `groups_require_mention` sedang bekerja sesuai namanya, dan
agent menunggu dipanggil.

**Ia bilang sedang offline waktu kamu mengirim pesan.** Pesannya tiba lebih dari 15 menit sebelum
daemon bisa menerimanya, saat gangguan atau restart yang lama, jadi gak dijawab terlambat. Kirim
lagi.

**Ia berhenti di tengah tugas dan bilang terpotong restart.** Semua yang sudah ia kerjakan tetap
tersimpan, dan kalau daemon kembali dalam 15 menit ia melanjutkan sendiri, sekali. Kalau gak, bilang
"continue" dan ia melanjutkan dari situ; perintah yang terpotong ditandai begitu.

**Menjawab "saya gak bisa" untuk sesuatu yang seharusnya bisa.** Tool-nya gak ada di daftar agent
itu. Tab **Settings** milik agent itu di dashboard menampilkan tool apa saja yang dimilikinya, dan
`[tools] enabled` di `.nouride/agents/<id>/config.toml` yang memberikannya.

**Setiap pesan gagal dengan error model.** Provider profile-nya gak punya kredensial, atau salah.
`nouride doctor` menyebutkan profilnya; `nouride secret` menampilkan nama kredensial yang ada, gak
pernah nilainya.

**Setiap balasan gagal di OpenAI dengan `Unsupported parameter: 'max_tokens'`.** Profilnya mengarah ke API OpenAI
sendiri dengan salah satu model barunya, dan mengirim batas output di field yang lama. Update Nouride lalu jalankan
lagi: start pertama menulis `max_tokens_field = "max_completion_tokens"` ke profil itu dan mencatatnya di log, dan
`nouride config check` sudah bilang sebelumnya bahwa ia akan begitu.
[Profil provider](/id/docs/providers/configuration/#profil-yang-umum)

## Perintah dan file

**Sebuah perintah ditolak bagaimanapun ditulisnya.** Direktori itu bukan workspace root bagi agent
tersebut. `nouride doctor` melaporkan root yang dideklarasikan tapi gak ada, kasus di mana semua hal
lain tampak hijau sementara setiap path ditolak.

**Agent minta approval untuk hal sepele, setiap kali.** Di `careful` perintah baru bertanya sekali dan
*allow always* mengingatnya; cuma daftar tetap yang bertanya setiap kali. Periksa sebuah perintah dengan:

```bash
nouride policy check rm -rf /tmp/build
```

Itu menjawab "apakah ini bakal ditahan" tanpa menjalankan apa pun, dan tetap jalan saat daemon mati,
yang justru saat orang sedang mendiagnosis penolakan.

**Agent terus bertanya soal `terraform destroy`.** Membongkar infrastruktur ada di daftar tetap: di `careful` ia
bertanya setiap kali dan gak pernah bisa jadi izin permanen. Membuat dan mengubah (`terraform apply`, `kubectl apply`)
bertanya sekali di `careful`, seperti perintah baru lainnya, dan *allow always* mengingatnya. Bagian bacanya, `plan`,
`get`, `describe`, apa pun dengan `--dry-run`, sama sekali gak ditahan.

## Agent eksternal dan server MCP

| Yang kamu lihat | Biasanya penyebabnya |
|---|---|
| **Answered by** gak menawarkan CLI apa pun, atau `nouride agents scan` bilang "No room for a coding CLI here" | Perintah agent kebagian kurang dari 512 MiB, batas bawah untuk satu sesi CLI. `nouride doctor` menyebutkan berapa yang boleh dipakai bersama; tambah memori box-nya |
| Status agent bilang CLI-nya belum ter-install | `nouride agents scan` menampilkan tiap CLI beserta perintah untuk meng-install-nya. [Meng-install CLI](/id/docs/manual/external-agents/#meng-install-cli) |
| Status agent bilang CLI-nya belum login | Claude Code: **Sign in** di Models → Coding CLIs. Codex: **Sign in** di tab Brain agent itu. Atau `nouride agents login <id>` |
| "… did not pass Nouride's check", dan agent-nya berhenti | CLI-nya di-update, dan versi barunya gak menjawab pengecekan satu baris dari Nouride. Balik ke versi sebelumnya (perintah install yang sama, dengan `@<versi>` di belakang nama paketnya), atau update Nouride; agent lain tetap jalan |
| Server MCP tetap belum tersambung setelah boot | Server-nya gagal start: journal menyebut kenapa, dan `mcp server did not start, trying again`. Sejak 0.8.10 server itu di-start lagi, dengan jeda yang makin panjang sampai lima menit, sampai ia hidup. Server `uvx` atau `npx` mengunduh dirinya sendiri saat pertama kali (`uvx` sekalian Python-nya), dan itu makan beberapa menit di koneksi lambat; server stdio punya lima menit untuk menjawab handshake-nya |
| Server MCP stdio kehilangan login-nya setelah upgrade | Sejak 0.8.1 server itu jalan sebagai user milik agent, yang gak bisa membaca apa yang disimpannya di HOME milik daemon. Login-kan lagi untuk tiap agent, kasih token-nya lewat `env_secrets` kalau ia membacanya, atau salin yang disimpannya ke folder milik agent itu |

## Memori dan beban

**Mesin terasa sesak saat build.** Perintah yang di-spawn agent berjalan di `nice 10`, dan unit
systemd yang dibuat membawa batas lunak `MemoryHigh` di 80% memori yang dilaporkan mesin. Di Raspberry
Pi OS, controller cgroup memory dimatikan sejak awal, jadi systemd menerima pengaturan itu dan gak
menegakkan apa pun:

```bash
systemctl show nouride -p MemoryCurrent --value   # `[not set]` berarti gak berlaku
```

Tambahkan `cgroup_enable=memory cgroup_memory=1` ke `/boot/firmware/cmdline.txt` lalu reboot.

**Build berakhir dengan `Killed`.** Sejak 0.7.19 perintah-perintah agent berbagi batas sendiri, di bawah
plafon unit, jadi daemon tetap menjawab seberat apa pun perintahnya, dan perintah yang melewati batas
itulah yang dihentikan (exit 137), dan agent diberi tahu meski pipeline-nya exit 0. `nouride doctor` menyebutkan berapa
banyak yang boleh dipakai
bersama; jalankan lebih sedikit sekaligus, atau beri mesin memori lebih. Di unit dari sebelum 0.7.19
doctor memberi peringatan: jalankan ulang skrip instalasi untuk menulis ulang unit.

[Konsumsi sumber daya dan pemilihan mesin →](/id/docs/architecture/performance/)

## Masih buntu

```bash
nouride logs -n 200          # log daemon sendiri: jalan tanpa journal, dan dari jarak jauh
nouride status               # agent, gateway, antrean, dalam satu layar
nouride config check         # validasi config tanpa menjalankan apa pun
```

`nouride logs` membaca log yang disimpan daemon sendiri, jadi tetap jalan di mesin tanpa journal dan
terhadap daemon jarak jauh lewat `NOURIDE_URL`.
