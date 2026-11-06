---
title: FAQ
description: Pertanyaan yang benar-benar ditanyakan orang sebelum dan sesudah memasangnya.
---

## Sebelum memasang

**Perlu GPU?**
Gak. Nouride gak menjalankan model. Ia memanggil endpoint yang kamu tunjuk, jadi RAM dan CPU gak
terpengaruh model mana yang dipakai agent.

**Perlu Docker?**
Gak. Binary-nya membawa runtime-nya sendiri, tanpa Node, tanpa Bun, tanpa Python, tanpa package
manager. Docker cuma salah satu cara menjalankannya, bukan syarat.

**Jalan di Raspberry Pi?**
Ya, dengan OS **64-bit**. `uname -m` harus menjawab `aarch64`. Gak ada build ARM 32-bit.

**Jalan di Mac?**
Ya, di Apple Silicon (M1 ke atas), sejak 0.7.20: installer yang sama, tanpa `sudo`, memasangnya sebagai
LaunchAgent yang jalan selama kamu login. [Pasang →](/id/docs/start/install/)

**Berapa biaya menjalankannya?**
RAM 64 MB adalah batas bawah terukur, start pertama juga (2026-10-17), dan 512 MB rekomendasinya. Sekitar 95 MB disk. Di bawah 1%
dari satu core saat idle. CLI coding milik agent eksternal adalah proses tambahan di atas itu: saat diam, sekitar 330 MB
untuk Claude Code dan 190 MB untuk Codex. [Setiap pengukuran →](/id/docs/architecture/performance/)

**Model apa saja yang bisa dipakai?**
Apa pun yang berbicara wire format Anthropic Messages atau OpenAI Chat Completions, jadi Claude, GPT,
OpenRouter, gateway perusahaan, Ollama lokal, atau proxy kamu sendiri.

**Bisa pakai langganan Claude atau ChatGPT saya?**
Ada dua cara. [Agent eksternal](/id/docs/manual/external-agents/) dijawab langsung oleh Claude Code atau Codex, login
pakai langganan kamu, lewat adapter ACP resmi yang juga dipakai Zed dan JetBrains. Di edisi Router,
[Nougate](/id/docs/providers/nougate/#menjalankannya-di-dalam-daemon) login ke akun Claude, ChatGPT, Copilot, Gemini,
atau Kiro dan menyajikan model-modelnya ke agent mana pun sebagai provider. Apa yang boleh dilakukan sebuah langganan
tetap ditentukan oleh ketentuan pembuatnya.

**Ada yang dikirim ke luar?**
Gak. Percakapan, ingatan dan kredensial adalah file di satu direktori di mesin kamu. Lalu lintas
keluar hanya ke endpoint model yang kamu konfigurasi, platform chat yang kamu sambungkan, web search
saat agent memakainya, indeks skill saat seseorang mencari skill, dan, saat badge update di dashboard
atau `nouride update` memintanya, daftar rilis publik di GitHub. Permintaan terakhir itu gak
mengirim apa pun tentang instalasimu.

**Open source?**
Kodenya terbuka untuk dibaca, tapi bukan open source: Nouride memakai PolyForm Strict License 1.0.0. Gratis untuk
pemakaian pribadi dan non-komersial lainnya; kodenya boleh dibaca, tapi tidak boleh diubah atau disebarkan ulang.
Pemakaian komersial butuh lisensi dari Nouverse Technologies. Bridge WhatsApp serta skill dan template agent bawaan
memakai MIT, jadi agent dan skill yang kamu jalankan bebas kamu ubah. Kodenya ada di
[github.com/nouverse/nouride](https://github.com/nouverse/nouride).

## Menyiapkan

**Perlu bot token untuk mencobanya?**
Gak. `nouride chat` dan chat di dashboard sama-sama bekerja tanpa token apa pun, lewat gateway
in-process yang sungguhan.

**Password pertama saya terlewat.**
Ia hanya ditampilkan sekali, dan gak ada yang menyimpannya (di Mac masih ada di
`~/nouride/.nouride/data/nouride.log`). Hentikan daemon, jalankan `sudo nouride users reset` (di Mac
tanpa `sudo`), lalu start lagi: semua akun dihapus, jadi admin baru dibuat dan
password-nya dicetak, sementara percakapan, secret dan agent gak tersentuh. Dengan Docker, jalankan
`docker compose run --rm nouride nouride users reset` selagi container daemon dihentikan. Set
`INITIAL_ADMIN_USERNAME` dan `INITIAL_ADMIN_PASSWORD` di `.env` sebelum start pertama dan ini gak bisa
terjadi.

**API key saya berakhir di mana?**
Di penyimpanan secret, `data/secrets.enc`, terenkripsi dengan mode `0600`, atau di sebuah variabel
lingkungan. `config.toml` hanya mendapat *nama* kredensialnya. Itulah sebabnya file config aman untuk di-commit dan dirender di
browser. Kunci penyimpanan itu disimpan terpisah darinya (0.8.19), di Linux di `/etc/nouride/nouride.env` milik root,
jadi salinan datanya gak bisa membukanya. [Secret →](/id/docs/architecture/storage/#secret)

**Kunci penyimpanan secret saya hilang.**
Nouride menolak start dan menyebut kunci mana yang dibutuhkannya. Kalau password backup sudah diatur (halaman Secrets di
dashboard), hentikan Nouride lalu jalankan `sudo nouride secret restore --stdin` dengan password itu: secret-nya ditulis
ulang dengan kunci yang dimiliki mesin ini. Tanpa password backup, secret-nya hilang bersama kuncinya, dan masing-masing
harus diisi lagi.

**Bisa menjalankan lebih dari satu agent?**
Itu justru intinya. Masing-masing adalah direktori Markdown dan memakan sekitar 0,4 MB RAM. Beri
masing-masing bot token sendiri dan mereka punya identitas terpisah di platform yang sama.

**Bisa dua agent saling bicara?**
Bisa, dan caranya berbeda tergantung di mana. Di grup, mereka saling nge-tag dan tag itulah serah
terimanya. Di chat satu lawan satu itu gak bisa, tiap bot punya percakapan pribadinya sendiri dengan
kamu, jadi agent memakai tool `ask_agent`, dan yang sedang kamu ajak bicara tetap satu-satunya yang
berbicara. Pekerjaan yang butuh lebih dari semenit lanjut di latar belakang, dan jawabannya kamu dengar
begitu datang. [Detail →](/id/docs/manual/chatting/#dua-agent-dalam-satu-ruangan)

## Menjalankannya

**Bot saya mengabaikan pesan grup.**
Di Telegram, privacy mode. BotFather → `/setprivacy` → Disable, atau jadikan bot admin. Di Discord,
**Message Content intent**: tanpa itu setiap pesan tiba kosong.

**Saya menyimpan koneksi dan gak terjadi apa-apa.**
Adapter gateway dibangun saat boot. Menambah atau mengubah gateway butuh restart, dan dashboard
mengatakannya serta menyediakan tombolnya.

**Orang asing mengirim pesan ke bot saya dan mendapat kode.**
Itu mode `pair`, default-nya. `nouride access approve <kode>`, atau halaman Access di dashboard. Pindah ke `allowlist`
setelah orang-orang yang kamu inginkan masuk: `nouride access mode allowlist`.

**Kenapa ia terus bertanya soal `terraform destroy`?**
Membongkar infrastruktur ada di daftar tetap: di `careful` ia bertanya setiap kali dan gak pernah bisa jadi izin
permanen. Membuat dan mengubah (`terraform apply`) bertanya sekali, seperti perintah baru lainnya, dan bagian
bacanya, `plan`, `get`, `describe`, `--dry-run`, sama sekali gak ditahan.

**Kenapa ia justru *gak* bertanya soal kebanyakan hal?**
Kalau gak ada yang menetapkan tingkat, ia `balanced`: cuma mengubah `config.toml`, memberi seseorang akses,
menghentikan daemon ini, mengganti secret yang tersimpan, kredensial yang keluar, dan mengubah paket sistem mesin ini
yang bertanya, selain yang sedikit yang [ditanyakan di setiap tingkat](/id/docs/manual/approvals/#daftar-tetap).
`/approvals careful` di chat membuatnya bertanya sebelum hal baru apa pun untuk kamu. Instalasi baru ditulis
`careful`.

**Agent lupa sesuatu setelah `/new`.**
`/new` memulai percakapan baru, dan yang lama disimpan ke memori dulu. Agent bisa menemukannya lagi
dengan `memory_search`; setelah nightly pass mengarsipkannya, ringkasannya ikut di antara ringkasan
terbaru di setiap prompt. Pass itu mati sampai kamu menyalakannya: `nouride memory set pass on`. Fakta
yang harus selalu ada tempatnya di `MEMORY.md` atau notes seseorang di People.
[Akses & orang →](/id/docs/manual/access/#nama-bukan-id)

**Bisa membaca PDF yang saya kirim?**
Bisa, tapi bukan dengan mengirimkannya ke model. Dokumen mendarat di workspace agent dan ia membukanya
dengan `read` atau sebuah perintah, jadi sebuah PDF gak berbiaya apa pun sampai agent melihatnya.
Gambar dan voice note *memang* dikirim ke model, kalau `read_images` dan `read_audio` menyala.

**Bisa browsing web?**
Ia bisa mencari dan mengambil halaman, dan skill bawaan **browser-automation** mengendalikan browser
sungguhan: login, mengklik sebuah situs, mengisi formulir. Browser-nya Playwright, dipasang oleh agent
dan dijalankan lewat `exec`, jadi setiap langkahnya melewati gerbang approval yang sama dengan perintah
lain. Ia butuh Node dan sekitar satu gigabyte memori kosong, dan bukan bagian dari daemon.
[Skill bawaan →](/id/docs/manual/skills/#bawaan)

**Bisa agent memasang program?**
Bisa, tanpa root, sebagai service atau di container. Instalasi global `npm`, `bun`, `pipx`, `uv`, `go`
dan `cargo` mendarat di `.nouride/bin`, dan `pip install` masuk ke satu Python env yang dipakai
bersama semua agent. Paket sistem lewat `nouride pkg`: di host mati kecuali `install.sh --allow-packages`
menyalakannya, di image Docker Nouride nyala, dan selalu minta izin kamu kecuali agent-nya `trusted`. `nouride doctor`
mendaftar apa saja yang sudah dipasang
para agent. Kalau [tiap agent punya user sendiri](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri), yang
di-install satu agent masuk ke `~/.local` miliknya sendiri, dan program untuk semua agent di-install orchestrator lewat
`nouride tools run`, yang selalu minta izin kamu.

**Bisa menambah tool saya sendiri?**
Bisa, lewat Model Context Protocol, dideklarasikan per agent.
[Server MCP →](/id/docs/architecture/agents/#server-mcp)

## Mengoperasikannya

**Bagaimana cara backup?**
`tar` atas `.nouride/` dan `.env` dengan daemon berhenti. `nouride db backup` membuat snapshot database
saja dan `nouride db restore <file>` mengembalikannya (daemon berhenti), tetapi snapshot itu disimpan
di bawah `data/`, di disk yang sama. Kunci penyimpanan secret gak ada di `.nouride/` (0.8.19): simpan salinannya di
tempat terpisah, atau atur password backup di halaman Secrets, yang bisa memulihkan secret-nya sendiri.
[Perawatan →](/id/docs/manual/maintenance/)

**Bagaimana cara upgrade?**
`nouride update --check`, lalu ambil dari halaman **Update** di dashboard atau dengan
`nouride update --start`, yang baru restart setelah gak ada yang jalan: giliran atau approval
ditunggu paling lama sepuluh menit, background job sampai selesai. `--now` gak menunggu. Menjalankan
ulang installer juga bisa. Keduanya mengganti binary dan membiarkan `.nouride/` apa adanya; migrasi
berjalan saat boot. Container di-update dengan menarik image-nya. Dari 0.7.x: lihat [Upgrade ke v0.8](/id/docs/deployment/upgrading-to-0-8/).
[Update →](/id/docs/deployment/updating/)

**Apa yang terjadi pada balasan yang sedang dikerjakan saat daemon restart?**
Gak ada yang hilang. Setiap langkah sebuah giliran disimpan saat terjadi, jadi setelah restart agent
bilang apa yang sudah selesai dan apa yang terpotong, lalu lanjut sendiri kalau daemon kembali dalam
15 menit; kalau lebih lama, ia lanjut begitu kamu bilang "continue". Pesan yang dikirim saat daemon
mati dijawab begitu ia kembali, kalau umurnya belum 15 menit; yang lebih tua dapat catatan singkat
sebagai gantinya.

**`nouride status` bilang gak ada daemon, padahal ada.**
CLI memakai instalasi di direktori kerja kamu kalau ada, dan yang di sebelah binary kalau gak, jadi
berdiri di dalam instalasi lain atau sebuah checkout akan mengarahkannya ke sana. Pesan error-nya
menyebut path yang dibacanya. "Permission denied" berarti control token-nya milik service account:
`sudo nouride status`, atau masukkan dirimu ke grupnya.

**`nouride restart` menolak.**
Cara kerjanya adalah meminta daemon keluar supaya supervisor-nya menghidupkannya lagi. Tanpa supervisor,
itu cuma berhenti, jadi ia menolak dan bilang apa yang harus dilakukan: `nouride service install` di
host, `docker restart` di container. Di bawah supervisor milikmu sendiri, isi `NOURIDE_SUPERVISOR_MODE`
di environment daemon.

**Bisa menjalankan CLI terhadap mesin jarak jauh?**
Bisa. `NOURIDE_URL` dan `NOURIDE_TOKEN`, dan setiap perintah yang berbicara ke daemon bekerja. Yang
bekerja pada file bertindak di mesin ini, bukan di mesin jarak jauh: `start`, `stop`, `setup`,
`service`, `config`, `db`, `pkg` dan `gateway rename`.

**Bisa menjalankan dua daemon dengan satu bot token?**
Gak. Dua bot Telegram yang polling satu token masing-masing hanya dapat separuh pesan. Saat migrasi,
hentikan yang lama sebelum menjalankan yang baru.

## Keamanan

**Apakah gerbang approval itu batas keamanan?**
Bukan, dan ia gak mengklaim begitu. Model yang bertekad bisa memutari klasifier apa pun. Ia ada supaya
pekerjaan biasa gak mengejutkan kamu. Yang benar-benar menahan adalah service account, user milik tiap
agent kalau ada, pengerasan systemd, workspace root, dan gerbang akses.

**Bisakah agent membaca API key saya?**
Gak lewat tool file-nya. `read` menolak mentah-mentah secret store, control token dan direktori
kredensial, dan membuka file kredensial lain (`.env`, `.npmrc`, private key) dengan nilainya
disembunyikan. Sebuah perintah bisa menjangkau direktori kredensial lewat `$NOURIDE_CREDENTIALS_DIR`:
memang itu gunanya, untuk script yang butuh file key lewat path. Gak ada key milik daemon yang sampai
ke sebuah perintah kecuali disebut di `exec_secrets` agent itu, key itu gak pernah masuk prompt, dan
kalau sebuah perintah mencetaknya, agent melihatnya dalam bentuk tersamar.

**Bisakah agent memberi dirinya izin lebih?**
Ia memegang tool `nouride`, jadi perlakukan ini sebagai pertanyaan sungguhan, bukan retoris. Tiga hal
menjawabnya. `[security] approvals = "trusted"` **gak** punya jalur tulis dari CLI dan gak punya
perintah chat, hanya dashboard di balik login dan file config. Mengubah `config.toml` (miliknya sendiri, milik
agent lain, atau milik daemon) ada di daftar tetap, ditanyakan di `careful` maupun `balanced`; di tempat setiap agent
adalah user-nya sendiri, file itu memang bukan miliknya untuk ditulis. Jadi agent gak bisa melebarkan izinnya
sendiri.

**Bisakah agent membaca file agent lain?**
Gak lewat tool file-nya, kecuali pack-nya mendeklarasikan direktori itu sebagai root. Di service Linux
dengan helper `nouride-run`, perintah yang dijalankannya lewat `exec` berjalan sebagai user miliknya sendiri, yang gak
bisa membaca folder agent lain atau data milik daemon. Di Docker, macOS, atau tanpa helper, perintah itu berjalan
sebagai account yang sama dengan semua agent lain, jadi di situ batasnya adalah account-nya, bukan agent-nya.
[Tiap agent punya user sendiri →](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri)
Apa yang diketahui satu agent tentang agent lain datang dari `AGENTS.md` miliknya dan dari pesan di bus.

**Apakah dashboard aman diekspos?**
Ia sebuah login, jadi taruh TLS di depannya kalau bisa dijangkau dari tempat yang gak kamu kendalikan.
Default-nya hanya loopback plus tunnel `ssh -L`, dan itu jawaban yang tepat bagi kebanyakan orang.

## Hal-hal yang belum dibangun

Dinyatakan terus terang, karena fitur yang belum ada tapi terbaca seperti bug memakan lebih banyak waktu
daripada yang didokumentasikan.

- **Backup di luar host.** Daemon membuat snapshot database, persona pack dan vault memorinya tiap
  hari, tapi semua snapshot ada di bawah `data/`: satu disk dengan yang dilindunginya.
- **Mode webhook Telegram.** Hanya long polling.
- **Batas pengeluaran dalam dolar yang bisa diandalkan.** `max_daily_cost_usd` default-nya mati, dan
  ia hanya bisa melihat model yang harganya diketahui. `max_daily_tokens` adalah plafon yang berlaku
  untuk semua model, default-nya juga mati, dan itu yang sebaiknya di-set.
- **ARM 32-bit.**
