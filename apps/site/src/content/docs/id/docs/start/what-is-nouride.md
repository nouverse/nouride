---
title: Apa itu Nouride?
description: Satu daemon ringan yang menjalankan beberapa agent AI dan menyambungkannya ke aplikasi chat yang sudah kamu pakai.
---

Nouride adalah program yang kamu jalankan di mesin kamu sendiri. Ia menampung beberapa **agent AI**:
masing-masing punya nama, kepribadian, dan memori sendiri, lalu menyambungkannya ke Telegram, Discord,
dan WhatsApp, jadi kamu bisa ngobrol dengan mereka seperti ngobrol dengan siapa pun.

Bentuknya satu binary. Runtime-nya sudah dibawa sendiri, jadi gak ada yang perlu dipasang di
sampingnya: tanpa Node, tanpa Bun, tanpa Python, tanpa package manager. Unduh, jalankan satu
perintah, lalu selesaikan setup-nya di browser.

## Apa yang BUKAN Nouride

**Bukan model.** Nouride gak menjalankan LLM di mesin kamu dan gak butuh GPU. Ia memanggil endpoint
yang kamu tentukan: Anthropic, OpenAI, OpenRouter, gateway kantor, atau Ollama di LAN kamu. Pemakaian
RAM kamu gak terpengaruh model mana yang kamu pilih.

**Bukan chatbot builder.** Gak ada flow, gak ada node graph, gak ada editor visual. Sebuah agent
adalah direktori berisi file Markdown, dan seluruh perilakunya adalah apa yang tertulis di file itu
ditambah tool yang kamu izinkan.

**Bukan layanan cloud.** Gak ada yang "lapor ke pusat". Percakapan, memori, dan kredensial adalah
file di satu direktori di mesin kamu.

## Untuk siapa

- Siapa pun yang ingin asisten pribadi yang bisa dihubungi dari HP, di hardware milik sendiri.
- Tim kecil yang ingin satu bot per peran, satu untuk deploy, satu untuk riset, satu untuk support, tanpa menjalankan satu container per bot.
- **Single-board computer dan homelab**: Dibuat untuk Raspberry Pi atau Linux SBC apa pun. Raspberry Pi 4 dengan RAM 2 GB sudah leluasa menjalankan sekumpulan agent 24/7.

## Dibuat untuk Raspberry Pi atau Linux SBC apa pun

Kebanyakan framework AI agent modern butuh runtime Python yang berat, container yang gemuk, atau RAM 2–4 GB cuma untuk start.

Nouride dirancang dari hari pertama dengan filosofi sebaliknya, **ringan, satu binary**:

- **Binary ARM64 native**: Dirilis sebagai binary mandiri untuk `linux-arm64` (Raspberry Pi OS 64-bit, Ubuntu ARM, Armbian, DietPi) dan `linux-x64`, plus `darwin-arm64` untuk Mac dengan Apple Silicon.
- **Batas bawah memori cuma 64 MB**: Seluruh daemon jalan di RAM 64 MB, start pertamanya juga (diukur 2026-10-17), dan idle di bawah 1% CPU. SBC hemat daya mana pun tetap adem, responsif, dan senyap.
- **Ramah MicroSD & flash**: State disimpan di SQLite lokal dengan Write-Ahead Logging (WAL) dan pembersihan retensi terbatas, jadi siklus tulis gak berlebihan dan kartu SD lebih awet.
- **Gak wajib pakai container**: Jalan langsung di bare metal sebagai service `systemd` yang ringan.
- **Gak butuh GPU**: Inferensi diserahkan ke API model atau Ollama lokal di LAN kamu.

Lihat [panduan Homelab & Mini PC](/id/docs/deployment/homelab/) untuk daftar board yang sudah teruji dan angka performanya.

## Gambarannya

```
   Telegram ─┐
    Discord ─┤                ┌──────────────────────────────────────────┐
   WhatsApp ─┼──── gateways ──┤  satu daemon, satu file SQLite, satu port │──► endpoint model kamu
   terminal ─┤                │                                          │
  dashboard ─┘                │  agent · tools · approval · scheduler    │
                              └──────────────────────────────────────────┘
                                              │
                                     .nouride/  ← config, database, agent, workspace
```

Semua di atas berjalan di **satu proses**. Agent bukan container dan bukan subprocess, sebuah agent
adalah direktori Markdown yang dirakit jadi prompt ketika ada pesan untuknya. Bahkan bridge WhatsApp
secara default jalan di proses yang sama; gak ada yang jalan di samping daemon selain yang dinyalakan agent:
perintahnya, dan CLI coding milik agent eksternal, satu proses per agent, dinyalakan di giliran pertamanya dan
dimatikan setelah lima menit diam.

Setiap pesan dan setiap langkah sebuah giliran dicatat saat terjadi, jadi restart, update, atau mati
listrik gak menghilangkan keduanya: pesan yang dikirim di sela-selanya dijawab begitu daemon kembali,
dan giliran yang terpotong menyimpan apa yang sudah dikerjakan dan bilang begitu.
[Caranya →](/id/docs/gateways/overview/#saat-daemon-restart)

## Apa yang bisa dilakukan agent

Langsung dari awal, agent bisa membaca dan menulis file, mencari dan mengambil isi web, menjalankan
perintah, mengingat sesuatu, menjadwalkan pekerjaan, dan menyerahkan tugas ke agent lain. Masing-masing
adalah tool bernama yang kamu nyalakan per agent, dan yang berbahaya bertanya dulu ke kamu sebelum
jalan.

| | |
|---|---|
| **Baca dan tulis** | `read`, `write`, `edit`, `multi_edit`, `glob`, `grep`: di dalam direktori yang kamu izinkan |
| **Menjalankan sesuatu** | `exec` untuk perintah sekali jalan, `session` untuk yang interaktif, background job untuk yang lama. Program yang dipasang agent masuk ke direktori bin miliknya sendiri, tanpa root |
| **Kode** | Menyerahkan fitur, refactor, atau test suite yang gagal ke CLI coding agent (Claude Code, Codex, OpenCode, dan lainnya) lewat skill bawaan `coding-agents`, lalu memeriksa hasilnya, atau jadi salah satunya: [agent eksternal](/id/docs/manual/external-agents/) adalah CLI coding dengan channel, misi, dan approval sendiri |
| **Web** | `web_search`, `web_fetch` |
| **Mengingat** | `memory_search`, `memory_read`, `memory_analyze`, `memory_write`: dengan memori menyala, setiap percakapan diarsipkan tiap malam jadi ringkasan dan fakta tentang orang di dalamnya, plus `MEMORY.md` yang dikelola agent sendiri |
| **Kerja bareng** | `delegate` ke subagent, `ask_agent` ke persona lain, `plan` untuk pekerjaan bertahap |
| **Belajar** | `skill_create` untuk skill baru; `skill_improve` dan `skill_install` meninggalkan draft yang kamu setujui |
| **Lainnya** | Server Model Context Protocol, dideklarasikan per agent |

## Biaya menjalankannya

Diukur, bukan diperkirakan, asal-usul tiap angka ada di
[halaman konsumsi sumber daya](/id/docs/architecture/performance/).

| | |
|---|---|
| **Batas bawah** | RAM 64 MB, start pertama dan setiap start sesudahnya. Diukur 2026-10-17, linux-arm64, dari page cache yang dingin. Di batas itu start-nya lambat: puluhan detik. |
| **Nyaman** | 512 MB. 1 GB kalau agent mengerjakan hal serius lewat `exec`. |
| **Agent eksternal** | Satu CLI coding per agent, sebagai tambahan: diam dengan satu sesi terbuka, sekitar 330 MB untuk Claude Code dan 190 MB untuk Codex. Cuma ditawarkan kalau perintah agent kebagian 512 MiB, jadi box 512 MB gak dapat. |
| **Disk** | ~95 MB terpasang, ditambah apa pun yang dihasilkan agent. |
| **CPU** | Apa saja. 0,18% dari satu core saat idle (diukur 2026-11-08 di mesin x64 dengan lima belas koneksi): hampir selalu menunggu jaringan. |
| **Gak butuh** | Postgres, Redis, vector database, GPU, atau model lokal. |

Daemon-nya bergantung langsung pada **empat** paket pihak ketiga: Hono untuk HTTP, serta discord.js,
grammY, dan Baileys untuk gateway Discord, Telegram, dan WhatsApp. Selebihnya pustaka standar Bun sendiri:
database, HTTP server, menjalankan proses, dan hashing password.

## Selanjutnya

- [Pasang](/id/docs/start/install/): Linux, Raspberry Pi, macOS, atau Docker.
- [Menyalakan pertama kali](/id/docs/start/first-run/): password sekali pakai, dashboard, tiga langkah singkat.
- [Arsitektur](/id/docs/architecture/overview/): kalau kamu ingin tahu caranya sebelum memutuskan.
