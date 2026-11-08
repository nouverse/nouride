---
title: Backup, upgrade, uninstall
description: Menjaganya tetap jalan, memindahkannya, dan mencabutnya dengan bersih.
---

## Sudah jalan?

```bash
curl -fsS @@HEALTH_URL@@
```

```json
{"status":"ok","edition":"basic","appliance":false,"uptime":147,"version":"<version>","agents":6,"install":"a1b2c3d4e5f6","gateways":{"telegram:bot":"connected"}}
```

`status` menjadi `degraded`, dan endpoint-nya menjawab **503**, ketika sebuah gateway mati, ketika
sebuah provider gagal tiga kali berturut-turut, atau ketika WAL SQLite melewati ambangnya. Nilainya
`shutting_down`, juga 503, selama daemon sedang berhenti. `issues` memuat daftar apa yang salah;
gateway yang cuma terputus atau sedang reconnect muncul di sana tanpa membuat pemeriksaan gagal.
`install` adalah hash direktori data, sehingga CLI bisa tahu ia sedang bicara dengan daemon yang benar
ketika dua instalasi di satu mesin berebut port.

**Periksa ini, bukan cuma status service.** `systemctl start` atau `launchctl load` yang mengembalikan 0 berarti prosesnya
di-spawn, bukan bahwa ia melayani, daemon yang menolak config-nya keluar *setelah* systemd melaporkan
sukses.

```bash
nouride status              # agent, gateway, antrean
nouride doctor              # apa yang salah, dan apa yang harus dilakukan
nouride service status      # supervisor mana, dan apakah keluar berarti dihidupkan lagi
```

## Start, stop, restart

```bash
# Linux / Raspberry Pi
sudo systemctl restart nouride
sudo systemctl stop nouride
sudo journalctl -u nouride -f

# macOS
launchctl kickstart -k gui/$(id -u)/tech.nouverse.nouride        # restart
launchctl unload ~/Library/LaunchAgents/tech.nouverse.nouride.plist  # stop (load -w untuk start)
tail -f ~/nouride/.nouride/data/nouride.log

# Docker
docker compose restart
docker compose logs -f
```

`nouride restart` jalan di semuanya, begitu juga **Restart** di Home dashboard dan
`/daemon-restart` di chat. Ketiganya menunggu sampai tidak ada giliran atau approval yang berjalan,
paling lama sepuluh menit, dan sampai setiap background job selesai, berapa lama pun itu. `--now`
(**Restart now**, `/daemon-restart now`) tidak menunggu, dan menghentikan job-job itu.
Cara kerjanya adalah **meminta daemon keluar supaya supervisor-nya menghidupkannya lagi**. Tanpa
supervisor, itu cuma berhenti, jadi semuanya menolak dengan 409 alih-alih diam-diam mematikan kamu.
`nouride service status` menjawab untuk proses yang benar-benar berjalan dan menyatakan dengan jelas
apakah ada yang akan menghidupkannya. Agent yang me-restart daemon memakai `--then "<apa yang dicek>"`,
jadi ia dibangunkan untuk mengecek begitu daemon kembali.

Di dalam container ia melaporkan `docker` dan menolak, dengan alasan yang sama: kebijakan restart ada
di luar container. Pakai `docker restart <container>`.

`nouride stop` adalah satu-satunya perintah yang mencapai daemon tanpa control API, ia membaca file
lock lalu mengirim sinyal, jalur yang tetap jalan ketika justru HTTP server-nya yang macet.

Stop atau restart membiarkan giliran yang sedang jalan menyelesaikan langkahnya. Masing-masing ditutup
dengan apa yang sudah dikerjakannya dan memberi tahu chat-nya sebelum daemon mati; lihat
[di bawah](#upgrade).

## Backup

Daemon men-snapshot database-nya sendiri tiap minggu, dan saat boot kecuali yang terbaru umurnya belum
seminggu, lalu menyimpan `backup_keep` yang terbaru (empat secara default, sebulan ke belakang) di `data/backups/db/`.
Setiap snapshot diperiksa integritasnya sebelum disimpan, dan yang gagal diperiksa dibuang, bukan
ditinggalkan di tempat yang bisa ditemukan restore.

Sejak 0.8.18 database juga menyimpan apa yang disimpan daemon untuk dirinya sendiri: agent mana yang sedang tidur,
kapan tiap peringatan terakhir dikirim, sesi CLI tiap agent eksternal, dan akun yang ditambahkan di halaman Models.
Snapshot, dan restore dari snapshot, membawa semua itu bersama yang lain.

`[daemon] backup_dir` menaruh snapshot terjadwal untuk database, pack, vault, config dan pool skill di tempat lain, misalnya di box
yang jalan dari kartu SD, sebuah flashdisk USB. Tulis direktori yang ada di dalam drive-nya
(`/mnt/usb/nouride`, bukan `/mnt/usb`): direktori itu gak pernah dibuat, jadi selama drive-nya dicabut
snapshot dilewati dan dicatat di log, bukan ditulis ke kartu di bawah mount point yang kosong.

```bash
nouride db backup            # ambil sekarang, sebelum melakukan sesuatu yang berisiko
nouride db list              # terbaru dulu
nouride db verify [file]     # periksa satu snapshot, atau database yang hidup
nouride db restore <file>    # kembalikan (daemon harus dihentikan)
```

Snapshot itu satu file SQLite biasa tanpa sidecar, jadi pemulihannya gak butuh perintah-perintah
ini: `cp` saja ke `data/nouride.db` dengan daemon berhenti, lalu hapus `nouride.db-wal` dan
`nouride.db-shm` di sebelahnya. `nouride db restore` melakukan itu, plus dua hal yang layak dimiliki,
ia menolak jalan kalau daemon hidup, dan ia memindahkan database yang digantikan ke
`nouride.db.replaced-<timestamp>` supaya me-restore snapshot yang salah pun bisa dibatalkan.

> **Kenapa bukan `cp` file yang hidup?** Karena kelihatannya berhasil. Database itu tiga file, dan
> semua yang di-commit sejak checkpoint terakhir ada di `nouride.db-wal`. Salinan file utamanya saja
> terbuka tanpa keluhan dan kehilangan baris-baris terbaru, backup yang ada, restore-nya bersih, dan
> diam-diam tertinggal. Snapshot memakai `VACUUM INTO` milik SQLite sendiri, yang konsisten terhadap
> daemon yang sedang jalan.

Untuk seluruh instalasi, bukan cuma database-nya, hentikan dulu:

```bash
sudo systemctl stop nouride
sudo tar -czf nouride-backup-$(date +%F).tar.gz -C @@INSTALL_DIR@@ .nouride .env
sudo systemctl start nouride
```

Di Mac, sama saja dengan `launchctl unload` / `load -w` pada `~/Library/LaunchAgents/tech.nouverse.nouride.plist`
di sekitar `tar -czf nouride-backup-$(date +%F).tar.gz -C ~/nouride .nouride .env`, tanpa `sudo`.

Isinya, diurutkan menurut seberapa sakit kehilangannya:

| | |
|---|---|
| **`memory/`** | yang diingat para agent: percakapan, orang, fakta bersama. File di sini adalah sumber kebenarannya; indeks pencarian di database dibangun ulang dari file-file ini. [Memori →](/id/docs/architecture/memory/) |
| **`agents/`** | `MEMORY.md` di atas segalanya, catatan milik tiap agent. Berbulan-bulan identitas yang menumpuk, gak ada di git |
| **`data/`** | percakapan, audit log, izin permanen, secret store, dan apa yang disimpan daemon untuk dirinya sendiri, misalnya agent mana yang sedang tidur |
| **`workspace/private/`** | di service Linux yang [tiap agent-nya punya user sendiri](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri), HOME tiap agent, `workspace/private/<id>/`: ssh key-nya, yang di-install-nya sendiri, login server MCP-nya, login CLI agent eksternal (`.cli/`), worktree misi. Backup bersama yang lain |
| **`home/`** | HOME milik daemon: ssh key, login CLI. Di Docker, macOS, atau tanpa helper, ini juga HOME semua agent |
| **`config.toml` dan `.env`** | apa yang membuat instalasi ini berbeda dari yang default |
| **kunci penyimpanan secret** | sengaja di luar `.nouride/` (0.8.19): `/etc/nouride/nouride.env` milik root di Linux, `~/.config/nouride/nouride.env` di Mac, environment container. Penyimpanan di dalam backup gak bisa dibuka tanpanya: simpan salinannya terpisah dari backup, atau atur password backup (lihat di bawah), yang bisa memulihkan secret-nya sendiri |
| **`workspace/`**, sisanya | apa pun yang dibangun para agent. Keluaran, bukan identitas, pulihkan kalau kamu ingin pekerjaannya kembali, lewati kalau cuma ingin daemon-nya kembali |
| **`bin/`, `lib/`, `opt/`** | program yang dipasang para agent. Menghemat pemasangan ulang, gak lebih |

Daemon juga menyimpan salinan bertanggal dari persona pack di `data/backups/agents/` dan dari vault
memori di `data/backups/memory/`, dan sejak 0.8.18 dari `config.toml`, orang-orangnya dan pustaka MCP di
`data/backups/config/` serta dari pool skill di `data/backups/skills/`. Itu beberapa kilobyte teks dan pemulihannya
cukup `cp`, sengaja, supaya gak butuh kode ini masih berfungsi. Salinan itu menutupi kasus agent merusak ingatannya
sendiri, proses malam yang keliru atau config yang tersimpan salah; ia gak menutupi disk yang mati.

Penyimpanan secret gak ada di salinan mana pun sampai kamu memberinya password backup (0.8.18): di halaman **Secrets**
dashboard, di bagian **Backup password**, atau dari shell:

```bash
read -rs PASS && printf '%s' "$PASS" | nouride secret seal --stdin; unset PASS
```

Sejak itu tiap snapshot config memuat `secrets.sealed`, yang cuma bisa dibuka password itu, dan satu snapshot
langsung diambil supaya kamu bisa mengecek. Sejak 0.8.19, salinan di sebelah penyimpanan, `data/secrets.sealed`, dibuat
ulang setiap kali penyimpanan berubah. Untuk mengembalikan secret, di box yang dibangun ulang atau saat kunci
penyimpanan hilang, dengan Nouride dihentikan (sebagai root di Linux, seperti tiap perintah yang membuka penyimpanan):

```bash
read -rs PASS && printf '%s' "$PASS" | nouride secret restore --stdin; unset PASS     # data/secrets.sealed
read -rs PASS && printf '%s' "$PASS" | nouride secret restore data/backups/config/<waktu>/secrets.sealed --stdin; unset PASS
```

Penyimpanan ditulis ulang dengan kunci install ini, dan yang tidak bisa dibuka disimpan terpisah sebagai
`secrets.enc.unopened-…`.

Simpan passphrase-nya di luar box. Kalau hilang, salinan yang disegel tetap tersegel, untuk kamu maupun siapa pun
yang menemukan drive-nya.

Semuanya ada di bawah `data/`, direktori yang di-mount oleh semua bentuk deployment, jadi snapshot
mendarat di tempat yang sudah kamu backup. Itu juga berarti semuanya **satu disk dengan yang
dilindunginya**: salin ke tempat lain untuk kegagalan yang membawa disk-nya sekalian.

## Upgrade

```bash
# Linux / Raspberry Pi / macOS
nouride update --start           # atau halaman Update di dashboard

# Docker
docker compose pull && docker compose up -d
```

Menjalankan ulang installer (`@@INSTALL_CMD@@`) juga bisa. Database, secret, agent pack, dan workspace
kamu di `.nouride/` gak disentuh dengan cara mana pun. [Update →](/id/docs/deployment/updating/)
Dari 0.7.x: lihat [Upgrade ke v0.8](/id/docs/deployment/upgrading-to-0-8/).

**Update menunggu sampai gak ada yang jalan.** `nouride update --start`, halaman Update, dan update
yang dijalankan agent sendiri me-restart dengan cara yang sama seperti `nouride restart`: begitu gak
ada giliran yang jalan dan gak ada approval yang menunggu, paling lama sepuluh menit, dan begitu gak
ada background job yang bekerja, berapa lama pun itu. Catatan yang dicetaknya menyebutkan apa yang
ditunggu, misalnya "restarting once the background job `make build` (12m) finishes, however long
that takes". Service seperti dev server gak dihitung: ia jalan sampai dihentikan. `--now` me-restart
saat itu juga dan menghentikan job-job itu.

Background job gak bertahan saat daemon mati, entah karena crash atau dihentikan: saat boot, agent
diberi tahu job mana saja miliknya yang terputus, dan bisa menjalankannya lagi. Itu disengaja.
Daemon memang dibuat untuk jalan seharian, dan mati lama berarti ia dihentikan atau ada yang salah.

**Siapa pun yang sedang di tengah giliran diberi tahu.** Saat daemon berhenti, setiap giliran yang
sedang jalan berhenti di langkah berikutnya, menyimpan semua yang sudah dikerjakannya, dan bilang begitu
di chat-nya sebelum daemon mati:

> ⚠️ I was interrupted by a restart while working on "deploy the site". Done: `read site.toml`,
> `git status`. Cut off: `exec ./deploy.sh` (it may have partly run). Everything I did is kept, and
> I'll carry on once I'm back. If I don't, say "continue".

Daemon gak bisa membedakan upgrade dari shutdown, jadi pesannya gak menebak-nebak. Kalau daemon
kembali dalam 15 menit, agent melanjutkan sendiri, sekali; kalau lebih lama dari itu, orangnya
tinggal bilang "continue". Kalau mau kerjanya benar-benar berhenti, pakai `/stop`, bukan restart.
[Yang mereka lihat →](/id/docs/manual/chatting/)

Kalau daemon dimatikan paksa, `kill -9`, OOM killer, listrik mati, gak ada pesan yang bisa dikirim
saat itu, jadi boot **berikutnya** menutup giliran itu dengan cara yang sama dan memberi tahu
percakapan yang sama begitu gateway sudah nyala. Pesan yang masuk selama daemon mati tetap dijawab
kalau dikirim dalam 15 menit terakhir.

Unit service memberi daemon 45 detik untuk melakukan ini, dan hanya mengirim sinyal ke daemon, supaya
ia bisa menghentikan perintahnya sendiri. Instalasi binary dari sebelum 0.7.0 yang di-update dengan
`nouride update` masih memakai unit lamanya, yang langsung membunuh perintah yang sedang jalan:
jalankan ulang installer sekali untuk menulis ulang unit itu. `nouride doctor` terus mengingatkan
sampai kamu melakukannya. Dengan Docker, beri container waktu yang sama dengan
`stop_grace_period: 45s`, seperti file compose bawaan.

Migrasi berjalan saat boot dan sudah dikompilasi ke dalam binary, jadi di dalam 0.8 gak ada langkah terpisah
yang harus diingat. Dari 0.7.x, 0.8.0 harus start sekali dulu:
[Upgrade ke v0.8](/id/docs/deployment/upgrading-to-0-8/). Periksa sesudahnya:

```bash
nouride version
nouride doctor
```

## Memindahkannya ke mesin lain

Satu direktori, jadi ini sebuah penyalinan:

1. Jalankan installer di mesin baru, lalu hentikan daemon yang dijalankannya.
2. Hentikan daemon lama.
3. Salin `.nouride/` dan `.env`, pertahankan kepemilikan dan mode, `data/` memuat file `0600`.
4. Bawa kunci penyimpanan secret (0.8.19), yang sengaja gak ada di `.nouride/`: baris `NOURIDE_ENCRYPTION_KEY` dari
   `/etc/nouride/nouride.env` di mesin lama, menggantikan baris yang dibuat installer di mesin baru. Atau, kalau
   password backup sudah diatur, jalankan `sudo nouride secret restore --stdin` di mesin baru: secret-nya ditulis ulang
   dengan kunci mesin baru itu. Tanpa salah satunya, yang baru menolak start dan menyebut kunci mana yang dibutuhkannya.
5. Jalankan yang baru lalu `nouride doctor`.
6. Baru setelah itu matikan yang lama. **Dua daemon gak boleh berjalan dengan bot token yang sama**:
   dua bot Telegram yang polling satu token masing-masing cuma dapat separuh pesan.

Di mesin baru, letaknya boleh di path lain. Start pertamanya di sana menamai ulang ke folder baru setiap path yang
disimpan database di bawah folder lama: lampiran di percakapan lama, log job, folder misi, folder tempat "always allow"
diberikan (yang diberikan untuk perintah yang dititipi secret akan bertanya sekali lagi). Log-nya bilang
`the install was moved`. Ini berlaku untuk instalasi yang sudah pernah start di 0.8.18 atau lebih baru minimal sekali
di tempat lamanya.

`workspace_dir` bisa menunjuk ke disk lain kalau di situ tempat pekerjaannya; selain itu gak ada yang
perlu pindah.

## Mengganti nama gateway

Satu-satunya operasi yang menulis ulang config, database, pack agen yang terikat ke gateway itu, dan
vault memori sekaligus, jadi ia menolak jalan selama daemon hidup:

```bash
sudo systemctl stop nouride
nouride gateway rename telegram:old telegram:new --apply
sudo systemctl start nouride
```

Tanpa `--apply` ia cuma menampilkan apa yang akan diubah. Vault di-snapshot dulu, di
`data/backups/memory/<stamp>-before-rename`.

Ia menolak, sebelum menulis apa pun, kalau ada pesan yang masih menunggu atau giliran yang terputus di
nama lama saat daemon berhenti (nyalakan daemon, biarkan ia menjawab, hentikan, lalu jalankan rename
lagi), dan kalau nama baru pernah dipakai gateway yang sudah dihapus, yang barisnya masih ada: pilih
nama yang belum pernah dipakai.

## Uninstall

```bash
# Linux / Raspberry Pi
sudo systemctl disable --now nouride
sudo rm /etc/systemd/system/nouride.service /usr/local/bin/nouride
sudo systemctl daemon-reload
sudo rm -rf @@INSTALL_DIR@@          # ini menghapus agent dan percakapan kamu

# macOS
launchctl unload -w ~/Library/LaunchAgents/tech.nouverse.nouride.plist
rm ~/Library/LaunchAgents/tech.nouverse.nouride.plist
rm -f /usr/local/bin/nouride ~/.local/bin/nouride
rm -rf ~/nouride                     # ini menghapus agent dan percakapan kamu

# Docker
docker compose down
rm -rf ./nouride
```

`/usr/local/bin/nouride` adalah launcher kecil yang dipasang installer di `PATH` (di Mac, sebuah link,
di `/usr/local/bin` atau `~/.local/bin`). `nouride service
uninstall` mencetak perintah yang tepat untuk supervisor yang kamu pakai.

## Disk, dan apa yang tumbuh

`.nouride/workspace/` tumbuh tanpa batas, isinya apa pun yang dihasilkan para agent.
`.nouride/memory/` tumbuh pelan: transkrip verbatim di sana dipadatkan setelah
`[memory] transcript_days` (180). Sisanya kedaluwarsa sesuai jadwal di `[retention]`: percakapan,
beserta file yang dikirim di dalamnya, dan baris audit setelah 30 hari, log background job setelah 14,
log daemon sendiri dan scratchpad setelah 3, output tool yang kebesaran setelah 2. Run scheduler hilang
setelah `[cron] run_retention_days` (3).

Daemon mengawasi disk-nya sendiri: sisa di bawah 1 GB memicu alert alih-alih sekadar mencatat, dan
`/health` melaporkan degraded begitu WAL SQLite lewat 100 MB. Dua-duanya nilai tetap sejak 0.8.0.

## Alert

Set ini sebelum kamu meninggalkannya:

```toml
[alerts]
gateway = "telegram:nouva"
chat_id = "123456789"
```

Tanpa itu, gateway yang mati cuma satu baris di log, jadi kamu baru tahu ketika sadar agent-nya sudah
lama diam, berjam-jam kemudian, dan terlihat seperti masalah lain. Boot memperingatkan kalau gateway
chat aktif tapi ini kosong.
