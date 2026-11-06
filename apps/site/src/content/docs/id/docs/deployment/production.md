---
title: Server & systemd
description: Memasang daemon di mesin Linux dengan benar, service account, unit-nya, dan pengerasannya.
---

Jalan singkatnya satu perintah:

```bash
@@INSTALL_CMD@@
```

Perintah itu mengerjakan semua isi halaman ini. Yang menyusul adalah apa yang dikerjakannya, buat saat
ada yang salah atau mesinnya cukup gak biasa sampai kamu ingin mengendalikannya sendiri.

## Native atau Docker?

Pilihannya bukan soal kepraktisan.

| | Native (systemd) | Docker |
|---|---|---|
| Agent bisa menjalankan perintah di host | **ya**: itu intinya | hanya di dalam container |
| Radius ledakan perintah buruk | host, dibatasi pengerasan unit dan kebijakan exec | container |
| Di mana `exec` mendarat | mesin kamu sungguhan | filesystem yang akan hilang |
| Restart saat crash / reboot | systemd | entrypoint image-nya, lalu restart policy container |

**Pilih native kalau kamu ingin agent yang bisa melakukan sesuatu di mesin kamu.** Pilih Docker kalau
kamu ingin agent yang berbicara dan membaca, terisolasi dari host yang kebetulan menjalankannya.

Menjalankan bentuk native adalah alasan model izin exec itu ada. Menjalankan Docker lalu mem-bind-mount
direktori home kamu ke dalamnya memberi kamu risiko native dengan ilusi isolasi.

**Bukan atas dasar memori**: keduanya terukur berjarak ~10 MB.

## 1. Pengguna yang bukan kamu, dan bukan root

```bash
sudo useradd --system --no-create-home --home-dir @@INSTALL_DIR@@/.nouride/home --shell /usr/sbin/nologin nouride
sudo mkdir -p @@INSTALL_DIR@@ && sudo chown -R nouride:nouride @@INSTALL_DIR@@
```

`nouride service install` **menolak membuat unit yang berjalan sebagai root.** Daemon ini menjalankan
perintah yang dipilih sebuah model bahasa, bisa dijangkau dari aplikasi chat; setiap batas lain di
dalamnya, kebijakan exec, sandbox workspace, mode file `0600`, mengasumsikan akun tanpa hak istimewa.
`sudo` ada di daftar yang gak pernah bisa diberikan permanen justru supaya eskalasi jadi keputusan
manusia per perintah, dan berjalan sebagai root menjadikannya default.

Satu-satunya pengecualian adalah mesin yang memang didedikasikan untuk agent, yang tugasnya ya
dioperasikan oleh agent itu. `--privileged` menulis unit tanpa sandbox (`ProtectSystem`,
`NoNewPrivileges`, dan sisanya) dan membolehkannya jalan sebagai root: agent lalu bisa memasang paket,
mengelola service, dan menjalankan container, dengan kebijakan exec sebagai satu-satunya gerbang. Ini
gak pernah jadi default.

Di instalasi biasa, kalau kamu menyalakannya, agent tetap bisa memasang paket sistem dari repositori kamu sendiri,
dengan izin kamu setiap kali kecuali agent-nya `trusted`: lihat [Paket sistem](/id/docs/deployment/system-packages/).

Pengguna terpisah juga berarti `ProtectHome=read-only` di unit-nya benar-benar melindungi direktori
home *kamu*, bukan milik daemon.

Installer menambahkan akun yang menjalankannya lewat `sudo` ke grup `nouride`, jadi `nouride` bisa
kamu pakai tanpa `sudo` setelah login ulang, atau setelah `newgrp nouride`.

## 2. Binary dan file-filenya

```bash
sudo -u nouride tar -xzf /tmp/nouride-linux-x64.tar.gz -C @@INSTALL_DIR@@
sudo -u nouride install -m 600 /dev/null @@INSTALL_DIR@@/.env
sudo -u nouride install -d -m 700 @@INSTALL_DIR@@/.nouride/home @@INSTALL_DIR@@/.nouride/home/.ssh
```

Binary-nya milik service account, dan itulah yang membuat `nouride update` bisa menggantinya tanpa
root. Artinya juga, setiap perintah yang dijalankan agent bisa menulis ulang binary itu, jadi **jangan
bikin link ke `/usr/local/bin`**: root jadi menjalankan file yang bisa diubah para agent. Installer
menaruh launcher kecil milik root di sana. Kalau dijalankan root, launcher menjalankan CLI sebagai
service account; kalau dijalankan orang lain, sebagai orang itu sendiri. Tanpa launcher, jalankan CLI
sebagai akun itu: `sudo -u nouride @@INSTALL_DIR@@/nouride …`. `nouride doctor` memperingatkan kalau
yang ada di sana link.

Unit-nya mengarahkan `HOME` ke `.nouride/home` (lihat di bawah), dan daemon gak membuatnya sendiri
kalau `HOME` memang sudah menunjuk ke sana. Installer mengerjakan langkah ini untukmu.

`.env` memuat key provider dan bot token. File ini `0600`, dimiliki service account, dan disebut dari
unit sebagai `EnvironmentFile=`: **jangan pernah** sebagai `Environment=`. File unit bisa dibaca semua
orang, ikut di-commit, dan ditempel ke laporan isu; key di `Environment=` adalah key yang bocor.

Kunci penyimpanan secret (0.8.19) ada satu file lebih jauh lagi: `/etc/nouride/nouride.env` milik root, `0600`, yang
disebut unit sesudah `.env` instalasi sebagai `EnvironmentFile=-/etc/nouride/nouride.env`. systemd membacanya sebagai
root sebelum menjalankan service-nya, jadi service account gak pernah membaca file itu dan salinan instalasi gak
membawa kunci. Kalau dijalankan root, launcher `nouride` menyerahkan kunci itu ke CLI lewat environment-nya, jadi
`secret decrypt`, `secret restore` dan `update --rollback` membuka penyimpanannya seperti yang dilakukan service.
[Secret →](/id/docs/architecture/storage/#secret)

## 3. Siapkan

Daemon menyala **tanpa konfigurasi apa pun**, jadi langkah ini opsional, browser bisa mengerjakannya.
Lewat SSH:

```bash
cd @@INSTALL_DIR@@
sudo -u nouride ./nouride setup
```

`setup` mengubah direktori tempat ia dijalankan menjadi sebuah instalasi, makanya pakai `cd`. Perintah
lain menemukan instalasinya dari mana pun begitu sudah ada `config.toml`.

[Flag-nya, dan kenapa gak ada `--api-key` →](/id/docs/start/first-run/#kalau-hanya-bisa-lewat-ssh)

## 4. Unit-nya

```bash
cd @@INSTALL_DIR@@
sudo -u nouride ./nouride service install --user nouride --dir @@INSTALL_DIR@@
```

Itu **menulis** `@@INSTALL_DIR@@/nouride.service` dan mencetak perintah untuk mengaktifkannya. Ia gak
memasang atau mengaktifkan apa pun: mengaktifkan service sistem adalah tindakan berhak-istimewa yang
mengubah host, dan CLI yang gak bisa kamu jalankan dengan aman sekadar untuk melihat apa yang akan
dilakukannya adalah CLI yang akhirnya gak kamu jalankan.

Baca file-nya, lalu:

```bash
sudo cp @@INSTALL_DIR@@/nouride.service /etc/systemd/system/nouride.service
sudo systemctl daemon-reload
sudo systemctl enable --now nouride
journalctl -u nouride -f
```

### Apa yang dilakukannya di luar `Restart=always`

| | |
|---|---|
| `ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges=true`, `RestrictSUIDSGID=true`, plus proteksi kernel dan namespace | Daemon menjalankan perintah sembarang secara desain, dan justru karena itu radius ledakan *daemon itu sendiri* harus dibatasi |
| `/tmp` dan `/var/tmp` privat lewat `TemporaryFileSystem=`, ukurannya dihitung dari mesin | tmpfs itu RAM; batas ukurannya mencegah clone besar ke `/tmp` menghabiskannya. Kembali ke `PrivateTmp=true` kalau ukurannya gak bisa dihitung |
| `ReadWritePaths=@@INSTALL_DIR@@` | Pengecualian yang diperlukan. `ProtectSystem=strict` membuat semuanya read-only, jadi tanpa ini daemon gak bisa menulis database-nya sendiri dan mati saat boot |
| `Environment=HOME=@@INSTALL_DIR@@/.nouride/home` | `ProtectHome=read-only` membuat home asli service user gak bisa ditulis, padahal ssh, git, dan login CLI semuanya menulis ke sana. Sejak 0.6 letaknya di dalam `.nouride/`, jadi menyalin direktori itu ikut memindahkan key dan login para agent |
| `After=network-online.target` | Gateway chat dan endpoint LLM semuanya jarak jauh; start lebih awal hanya memenuhi journal dengan badai reconnect |
| `StartLimitBurst=5` dalam `StartLimitIntervalSec=120` | Kalau gak ada, config yang ditolak daemon membuatnya restart terus selamanya, dan `systemctl status` terus bilang "activating". Setelah lima kali gagal dalam dua menit, statusnya tetap `failed`, dengan alasannya di journal; jalankan `systemctl reset-failed nouride` setelah diperbaiki |
| `KillSignal=SIGTERM` hanya ke daemon (`KillMode=mixed`), `TimeoutStopSec=45` | Saat berhenti, giliran yang sedang jalan menyelesaikan langkahnya dan menyebutkan apa yang sudah dikerjakan, lalu daemon menghentikan proses-prosesnya sendiri secara berurutan. Default-nya mengirim sinyal ke semua proses sekaligus, jadi perintah yang sedang dijalankan sebuah giliran mati duluan. 45 detik cukup untuk masa drain daemon yang 30 detik |
| Penjaga update lewat `ExecStartPre=` | Selama sebuah update belum dikonfirmasi, ia menghitung jumlah start, dan di start keempat ia mengembalikan versi sebelumnya. Letaknya di luar binary karena binary baru yang langsung crash gak bisa menyelamatkan dirinya sendiri |
| `MemoryHigh` di 80% memori mesin | Plafon **lunak** untuk daemon dan semua yang dijalankannya |
| `Delegate=yes` (sejak 0.7.19) | Daemon membelah cgroup-nya saat boot: dirinya sendiri, dengan memori yang dilindungi dan didahulukan di CPU, dan setiap perintah yang dijalankan agent (`exec`, job latar belakang, sesi terminal, server MCP), dengan batas di bawah `MemoryHigh`. Perintah yang melewati batas itulah yang dihentikan kernel, sendirian. Dulu, perintah itu menahan seluruh unit di plafon dan kernel ikut men-throttle daemon sampai tidak ada yang menjawab. Di systemd 257 ke atas, filesystem cgroup adalah tampilan milik daemon sendiri (`ProtectControlGroups=private`); sebelum 257 baris itu dihilangkan, karena akan membuat cgroup daemon sendiri read-only |

`MemoryHigh` ditulis sebagai angka absolut yang dihitung saat instalasi, **bukan** `80%`: di dalam LXC,
systemd menghitung persentase terhadap memori *host*, dan pada container 2 GB di node 62 GB itu keluar
sebagai 49,8 GB.

Perintah yang di-spawn agent juga berjalan di `nice 10`, jadi sebuah build mengalah pada CPU untuk
sebuah giliran alih-alih membuat setiap chat diam sampai build-nya selesai.

`nouride doctor` menyebutkan berapa banyak memori yang boleh dipakai perintah-perintah itu bersama.
Unit yang ditulis sebelum 0.7.19 tidak menyerahkan cgroup-nya: doctor memberi peringatan, dan menjalankan
ulang skrip instalasi menulis ulang unit tanpa menyentuh `.nouride/`. Docker tidak punya unit yang bisa
menyerahkan cgroup, jadi beri container batas memori, dan perintah-perintah itu tetap yang pertama dihentikan
kernel.

### Tiap agent punya user sendiri

`service install` juga menulis unit milik `nouride-run`, helper root yang menjalankan perintah tiap agent sebagai user
miliknya sendiri, `nr-<agent>`: `nouride-run.socket` dan `nouride-run@.service`, di samping `nouride.service`, beserta
perintah untuk menyalinnya. Helper-nya sendiri harus sudah terpasang dulu. `install.sh` mengerjakannya di langkah
"Each agent its own user"; kalau manual, sebagai root:

```bash
sudo groupadd --system nr-agents
sudo groupadd --system nr-creds
sudo usermod -aG nr-agents nouride
sudo install -d -o root -g root -m 755 /usr/local/lib/nouride-run
sudo install -o root -g root -m 755 @@INSTALL_DIR@@/run/nouride-run /usr/local/lib/nouride-run/nouride-run
```

Lalu berikan `.nouride/bin`, `lib`, dan `opt`, beserta isinya, ke grup `nr-agents` untuk dibaca dan dijalankan, dengan
folder-folder-nya setgid, seperti langkah itu, dan aktifkan `nouride-run.socket` sebelum daemon start: saat boot,
daemon menanyainya sekali apakah perintah agent jalan sebagai user masing-masing. Tanpa helper, perintah semua agent jalan sebagai `nouride`, dan boot serta `nouride doctor`
bilang begitu.
[Tiap agent punya user sendiri →](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri)

## 5. Periksa

```bash
systemctl status nouride
nouride doctor
nouride status
curl -fsS @@HEALTH_URL@@
```

**Periksa `/health`, bukan hanya status service.** `systemctl start` yang mengembalikan 0 berarti
prosesnya di-spawn, bukan berarti ia sudah melayani; daemon yang menolak config-nya keluar *setelah*
systemd melaporkan sukses. Selama boot, `/health` menjawab 503 `starting` beserta langkah yang sedang
dikerjakan, jadi `curl -f` menunggu sampai boot selesai.

`nouride restart` **menolak jalan** kalau gak ada yang akan menyalakan daemon lagi, misalnya daemon yang
dijalankan manual dan bukan oleh unit. "Restart" yang berarti "berhenti sampai kamu sadar" adalah jenis
kesalahan yang paling buruk, jadi ia mengembalikan 409 dengan penjelasan alih-alih mematikan diam-diam.
`nouride update --check` menyebutkan supervisor yang dimiliki daemon.

## Mengekspos dashboard

Dashboard bind ke loopback secara default, dan bagi kebanyakan orang jawaban yang benar adalah
membiarkannya di situ:

```bash
ssh -L @@PORT@@:127.0.0.1:@@PORT@@ user@server-kamu
```

Untuk menyajikannya di jaringan, pakai `--host 0.0.0.0` saat instalasi, atau:

```toml
[dashboard]
enabled = true
host = "0.0.0.0"
port = @@PORT@@
```

Kalau di-bind ke `0.0.0.0`, banner login pertama di log mencantumkan alamat LAN mesin ini selain
`localhost`, kecuali `public_url` diset, yang kemudian dicantumkan sebagai gantinya.

Taruh reverse proxy dengan TLS di depannya kalau ia bisa dijangkau dari tempat yang gak kamu
kendalikan. Dashboard adalah sebuah login, dan login lewat HTTP polos adalah password di kabel.

## Menjalankan ulang installer setelah update

`nouride update` mengganti binary, dashboard, dan skill. Ia gak pernah menyentuh unit, launcher, atau
service paket: semuanya milik root, sedangkan update jalan sebagai service account. Jadi instalasi yang
hanya pernah di-update dengan cara itu tetap memakai apa yang terpasang saat instalasi. Jalankan ulang
installer sekali untuk memperbaruinya. `.nouride/` dibiarkan, dan `nouride doctor` memberi tahu kapan
sudah waktunya.

- **0.8** menambahkan `nouride-run`, supaya perintah tiap agent jalan sebagai user miliknya sendiri. Helper dan
  unit-nya milik root, jadi instalasi yang cuma pernah di-update lewat `nouride update` mendapatkannya dari installer.
- **0.7** mengubah cara restart menghentikan perintah yang sedang jalan (`KillMode=mixed`, di atas) dan
  menaruh launcher di `PATH` menggantikan link.
- **0.6** memindahkan `HOME` para agent ke `.nouride/home`. Installer menyalin `.ssh`, `.gitconfig`,
  `.config`, `.local`, `.npmrc`, `.netrc`, `.docker`, `.kube`, `.aws`, dan `.gnupg` dari HOME lama,
  tanpa pernah menimpa yang sudah ada. Sebelum itu, daemon tetap menjalankan perintah para agent dengan
  `HOME` tersebut; penyalinannya sendiri sudah dilakukan setiap start 0.7.x. File aslinya dibiarkan di
  tempatnya.

## Apa yang di-backup

`.nouride/` dan `.env`, dengan daemon berhenti.
[Backup, upgrade, uninstall →](/id/docs/manual/maintenance/)
