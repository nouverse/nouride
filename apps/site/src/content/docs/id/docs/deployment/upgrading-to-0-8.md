---
title: Upgrade ke 0.8
description: Jalan dari 0.7 ke 0.8, apa yang berubah di box setelah sampai, dan cara kembali.
---

0.8 cuma mau jalan di data yang sudah pernah dijalankan 0.8.0. Dari 0.7 artinya ada satu atau dua kali start tambahan
di tengah jalan, masing-masing install biasa. Kalau ada langkah yang kelewat, gak masalah: versi berikutnya menolak
jalan sebelum menulis apa pun, dan bilang versi mana yang harus dijalankan dulu.

## Lewat jalan mana

| Kamu di versi | Yang dilakukan |
|---|---|
| 0.8.0 | Update seperti biasa: `nouride update`, halaman Update, atau `docker compose pull && docker compose up -d`. |
| 0.7.28 atau 0.7.29 | Jalankan 0.8.0 sekali, lalu update ke yang terbaru. |
| 0.7.11 sampai 0.7.27 | Jalankan 0.7.29 sekali, lalu 0.8.0 sekali, lalu update ke yang terbaru. |
| 0.7.10 atau lebih lama, 0.6, 0.5 | Sama, tapi manual: 0.7.29, lalu 0.8.0, lalu yang terbaru. |

Di 0.7.11 ke atas, `nouride update` dan halaman Update di dashboard menawarkan tiap rilis di tengah jalan satu per
satu dan bilang kenapa. Ambil satu, tunggu sampai jalan, baru ambil yang berikutnya.

### Lewat installer

Tiap baris adalah install biasa. Tunggu sampai dia bilang Nouride sudah siap sebelum menjalankan baris berikutnya.

```bash
curl -fsSL @@INSTALL_URL@@ | sudo sh -s -- --version v0.7.29   # cuma dari 0.7 yang lebih lama dari 0.7.28, 0.6 atau 0.5
curl -fsSL @@INSTALL_URL@@ | sudo sh -s -- --version v0.8.0
curl -fsSL @@INSTALL_URL@@ | sudo sh
```

### Lewat Docker

Container gak punya pengaman update: `pull` dari 0.7 ditolak saat start pertama, dan container-nya terus restart
sampai kamu menjalankan langkah yang dia sebut. Sebelum mengubah apa pun, cek dulu apakah image baru mau jalan di
data kamu:

```bash
docker run --rm -v "$PWD/nouride:/app/.nouride" @@DOCKER_IMAGE@@ nouride config check
```

Pakai folder atau volume yang di-mount file compose kamu ke `/app/.nouride`. Lalu nyeberang satu tag demi satu tag,
di data yang sama:

1. Cuma dari versi lebih lama dari 0.7.28: beri image di file compose kamu tag `0.7`, `docker compose up -d`, lalu
   tunggu sampai `docker compose logs` bilang sudah siap.
2. Ganti ke tag `0.8.0` (tag itu, bukan `0.8`, yang isinya 0.8 terbaru), `docker compose up -d`, lalu tunggu sampai
   siap.
3. Hapus lagi tag-nya, seperti file compose aslinya, lalu `docker compose up -d`.

Kalau satu langkah kamu hentikan sebelum dia bilang siap, versi berikutnya bisa menolak datanya lagi: jalankan
langkah itu sekali lagi.

### Seperti apa penolakannya

```text
refusing to start: this release upgrades only from 0.8.0, and the data in /srv/nouride/.nouride/data ...
```

Gak ada yang ditulis: database dan `config.toml` tetap seperti semula. Jalankan versi yang dia sebut, sekali, lalu
coba lagi.

## Sebelum mulai

- **Backup dulu.** Seluruh folder `.nouride/`, dengan daemon dimatikan. Di install Linux yang tiap agent-nya punya
  user sendiri (lihat di bawah), `workspace/private/` adalah folder rumah tiap agent: login, kunci SSH, dan program
  yang dia install sendiri. Kalau folder itu gak ikut di-backup, semua agent dan CLI coding harus login ulang.
- **Cek config-nya.** `nouride config check` dengan versi baru menyebut tiap bentuk lama yang ditolak dan agent yang
  gak akan jalan. [Daftar lengkap bentuk lama →](/id/docs/deployment/updating/#dari-versi-yang-lebih-lama)

## Yang berubah di box

### Di 0.8.0

- **Bentuk lama ditolak, bukan ditulis ulang.** 0.7 yang terakhir sudah menulis ulang semuanya di disk saat start.
  Kalau ada yang muncul lagi belakangan, misalnya di pack yang disalin dari tempat lain atau diedit tangan, daemon
  atau agent itu berhenti dan menyebut baris yang harus ditulis sebagai gantinya.
- **Tiap agent punya user sendiri**, di install Linux lewat installer. Perintah, job di background, session, dan
  perintah terjadwal tiap agent jalan sebagai `nr-<agent>`, lewat helper `nouride-run` yang dipasang installer:
  - folder rumahnya `workspace/private/<agent>`;
  - yang dia install masuk ke `~/.local` miliknya sendiri;
  - dia gak bisa membaca database, `data/`, atau folder agent lain;
  - program yang dipakai semua agent (`.nouride/bin`, `lib`, `opt`) cuma bisa diubah lewat `nouride tools run`. Itu
    tugas orchestrator, dan dia selalu minta izin kamu dulu, di level approval mana pun.

  Di Docker, di macOS, atau tanpa helper, perintah tetap jalan sebagai user daemon, seperti sebelumnya.
  `nouride doctor` bilang mana yang kamu punya, dan kenapa.

### Di 0.8.1

- **CLI coding sebagai agent**, kalau kamu mau: Claude Code atau Codex yang menjawab giliran sebuah agent. Nouride
  bicara dengan mereka lewat [Agent Client Protocol](https://agentclientprotocol.com), lewat adapter resmi di
  [registry ACP](https://agentclientprotocol.com/registry), yang sama dengan yang dipakai Zed dan JetBrains. Gak
  ada yang berubah sampai kamu membuatnya. [Agent eksternal →](/id/docs/manual/external-agents/)
- **Server MCP stdio jalan sebagai user agent-nya sendiri**, di tempat yang tiap agent-nya punya user sendiri. Dia
  memakai folder rumah dan program milik agent itu, dan mulai di folder agent kecuali blok-nya menyebut `cwd`.
  Sebelumnya dia jalan sebagai user daemon, jadi server shell atau file yang diberikan ke satu agent bisa membaca
  database dan folder semua agent lain.
  Server yang menyimpan login-nya di folder rumah daemon gak menemukannya lagi, karena user agent gak bisa membaca
  folder itu. Lakukan salah satu:
  - login ulang server itu, untuk tiap agent;
  - berikan token-nya lewat `env_secrets`, kalau server itu membaca token dari variabel;
  - salin yang dia simpan ke folder agent itu.
- **"Free in its folder" cuma berlaku kalau tiap agent punya user sendiri.** Di preset itu CLI gak bertanya apa
  pun, termasuk untuk push atau POST. Di Docker, di macOS, atau tanpa helper, dia bertanya seperti "Ask when risky",
  apa pun yang tertulis di pack.
- **`[llm] fallback_model` di pack ditolak** untuk agent itu. Tulis
  `fallbacks = [{ provider = "<provider pack itu>", model = "<model-nya>" }]` sebagai gantinya. 0.8.0 sudah menulis
  ulang ini saat start pertamanya, jadi kamu cuma akan menemuinya di pack yang balik dari git atau diedit tangan.

## Kembali ke versi sebelumnya

- **Dari 0.8.1 ke 0.8.0:** install 0.8.0 (`--version v0.8.0`, atau tag image `0.8.0`). Gak ada langkah database.
  0.8.0 memberi peringatan untuk `[external]`, `[look]` dan `[[external_clis]]` sebagai key yang gak dikenal, lalu
  mengabaikannya. Agent eksternal menjawab pakai model `[llm]`-nya sampai 0.8.1 dipasang lagi.
- **Dari 0.8 ke 0.7:** kalau di 0.8.1, install 0.8.0 dulu: 0.8.1 menolak me-restore snapshot dari sebelum 0.8.0.
  Lalu, dengan daemon dimatikan, `nouride db restore` snapshot `data/backups/db/nouride-<time>-before-069.db` yang
  diambil 0.8.0 saat start pertamanya, lalu install 0.7.29. [Kembali ke rilis sebelumnya →](/id/docs/deployment/updating/#kalau-versi-barunya-salah)

## Kalau ada yang aneh sesudahnya

| Yang kamu lihat | Artinya |
|---|---|
| Daemon gak mau jalan, dan log-nya bilang `install 0.8.0 first` | Ada langkah yang kelewat. Jalankan versi yang dia sebut, sekali. |
| Satu agent gak jalan | Pack-nya masih punya bentuk lama atau key yang gak dia terima. `nouride config check` menyebut file dan barisnya. |
| Server MCP stdio bilang belum login | Login-nya dulu ada di folder rumah daemon. Login ulang untuk agent itu, atau pakai `env_secrets`. |
| Perintah agent gak bisa menulis ke tempat yang dulu bisa | Sekarang dia jalan sebagai user sendiri. Tambahkan folder itu ke `[workspace] roots` di pack-nya, atau, untuk program yang dipakai semua agent, install lewat `nouride tools run`. |
| Gak ada CLI coding yang ditawarkan di New Agent | Perintah agent di box ini cuma boleh memakai kurang dari 512 MiB. `nouride doctor` bilang berapa batasnya. |
