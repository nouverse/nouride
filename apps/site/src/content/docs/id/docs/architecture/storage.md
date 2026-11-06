---
title: State & penyimpanan
description: Satu file SQLite, satu direktori Markdown, dan apa yang jadi sumber kebenaran untuk apa.
---

Dua jenis state, sengaja dipisah.

**Markdown adalah sumber kebenaran untuk identitas.** Persona memang dimaksudkan untuk disunting tangan
dan di-diff di git.

**SQLite adalah sumber kebenaran untuk semua yang punya siklus hidup.** Sesi, approval, job, jejak
audit, gak ada yang mau membaca itu sebagai file.

## Direktorinya

```
.nouride/                      satu instalasi, satu volume
├── config.toml                config daemon
├── people/<key>.toml          satu orang per berkas (sejak 0.8.18), versi terakhirnya di sampingnya
├── data/                      state milik daemon
│   ├── nouride.db             SQLite, 0600: sesi, giliran, cron, approval, audit, pemakaian, indeks memori
│   ├── nouride.db-wal         mode WAL - baca dan tulis bersamaan
│   ├── secrets.enc            0600, terenkripsi (0.8.19), cuma bisa ditulis dari luar; kuncinya disimpan di tempat lain
│   ├── secrets.sealed         salinan yang disegel ke password backup, dibuat ulang di tiap perubahan (0.8.19)
│   ├── .control-token         0640 - yang dibaca CLI untuk autentikasi (bisa dibaca grup)
│   ├── whatsapp/              sesi Baileys, AES-256-GCM saat disimpan
│   ├── backups/agents/        salinan bertanggal persona pack, termasuk skills.toml dan mcp.toml-nya
│   ├── backups/config/        salinan bertanggal config.toml, people/, agents/mcp.toml dan secrets.sealed (0.8.18)
│   ├── backups/db/            snapshot mingguan nouride.db, masing-masing diverifikasi
│   ├── backups/knowledge/     salinan bertanggal dokumen knowledge base (0.8.20)
│   ├── backups/memory/        salinan bertanggal vault memori, file yang gak berubah di-hard-link
│   └── backups/skills/        salinan bertanggal pool skill (0.8.18)
├── agents/
│   ├── <id>/                  persona pack - identitas yang layak di-git
│   │   ├── IDENTITY.md SOUL.md AGENTS.md MEMORY.md
│   │   └── config.toml  skills.toml
│   └── skills/<nama>/SKILL.md kumpulan skill yang dipakai bersama semua agent; skills/.history/ yang diganti perbaikan
├── attachments/<agent>/<chat>/<tanggal>/   yang dikirim di chat - agent-nya membaca miliknya sendiri
├── jobs/<agent>/              log perintah background - agent-nya membaca miliknya sendiri
├── tool-output/<agent>/<percakapan>/   hasil tool yang terlalu besar untuk konteks
├── credentials/               kredensial berbentuk file, gak terjangkau tool file
├── knowledge/<collection id>/ knowledge base: satu folder per koleksi, dokumennya apa adanya (0.8.20)
├── memory/                    percakapan, profil dan pengetahuan bersama (vault memori)
├── bin/                       program yang dipasang untuk semua agent, ada di PATH tiap perintah
├── lib/  opt/                 kebutuhan program-program itu, dan env Python bersama (opt/python)
├── home/                      HOME milik daemon: kunci ssh, known hosts, login CLI - HOME semua agent kalau mereka memakai user daemon
└── workspace/
    ├── shared/                semua agent - direktori kerjanya
    └── private/<id>/          satu agent, gak terbaca yang lain - HOME-nya bila ia punya user sendiri
```

Yang path-nya diberikan ke perintah agent ada di samping `data/`, bukan di dalamnya (0.8.0): di instalasi Linux yang
menjalankan perintah tiap agent sebagai user miliknya sendiri, gak ada perintah yang masuk ke `data/`, dan tiap agent
menjangkau log job, lampiran dan output tool panjang miliknya sendiri, bukan milik agent lain. Yang dipasang agent lalu
masuk ke `~/.local` miliknya sendiri; `bin/`, `lib/` dan `opt/` bisa dijalankan semua agent dan cuma daemon yang bisa
mengubahnya.

Di sana, HOME sebuah agent adalah `workspace/private/<id>/`, diisi sekali dari `home/`: kunci ssh dan known hosts-nya,
yang di-install-nya sendiri, login server MCP stdio-nya, login CLI agent eksternal (`.cli/<cli>/<profile>`), dan
worktree misi (`missions/<id>/worktree`). Backup folder ini seperti kamu mem-backup `home/`. Di Docker, macOS, atau
tanpa helper, semua agent memakai user daemon dan `home/` adalah HOME mereka.
[Tiap agent punya user sendiri →](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri)

Empat kunci menunjuk empat di antaranya, `data_dir`, `agents_dir` dan `workspace_dir` di bawah
`[daemon]` serta `[memory] dir`, bukan satu root, karena keempatnya berbeda dalam kebijakan backup,
sensitivitas dan ukuran. `workspace_dir` di disk lain adalah pengaturan yang didukung, dan persona pack
sengaja bukan sebuah workspace.

Di samping `.nouride/` ada instalasinya sendiri: binary `nouride`, `dashboard/` dan skill bawaannya.
Setiap update menggantinya, jadi perintah agent yang menulis ke sana ditolak. Di instalasi binary,
semuanya milik service account, dan itulah yang membuat `nouride update` bisa menggantinya tanpa
root.

## SQLite, dan gak ada yang lain

Tanpa Postgres, Redis, vector database, atau daemon eksternal. Satu file, mode WAL, dibuka lewat driver
native Bun.

Skemanya berupa migrasi bernomor yang cuma maju dan dikompilasi ke dalam binary; `PRAGMA user_version`
mencatat apa yang sudah diterapkan. Gak ada langkah migrasi yang harus dijalankan, binary baru
bermigrasi saat boot. Sebelum menyentuh database yang sudah ada, ia memeriksa bahwa SQLite miliknya
sanggup memuat skemanya (3.43 ke atas, dengan FTS5), lalu membuat snapshot file-nya. Ia menolak
database yang migrasinya gak ia kenali, atau yang sudah dimigrasi build yang lebih baru, alih-alih
menjalankan query terhadap skema yang salah ia pahami. Migrasi yang membuat lebih dari seperempat file
kosong diikuti `VACUUM`, kalau memorinya cukup untuk membangun ulang file itu.

Isinya: sesi dan giliran-gilirannya, jurnal tiap giliran yang sedang berjalan, inbox berisi pesan yang
belum dijawab, eksekusi tool, approval, izin permanen, akses pengirim, background job, cron job dan
run-nya, draft skill, pemakaian dan biaya, log daemon sendiri, akun dan sesi login dashboard, serta
indeks memori.

SQLite memang database-nya, bukan sekadar subset SQL yang portabel: indeks memori memakai mesin
full-text miliknya, FTS5, dan query memakai recursive CTE dan fungsi JSON kalau membantu. Setiap query
tinggal di file `*.store.ts` dan selebihnya menerima sebuah store, ditegakkan aturan lint, yang juga
memeriksa bahwa setiap query mengikat nilainya dan rencana eksekusinya mencari, bukan memindai seluruh
tabel.

:::caution[Backup tetap di disk yang sama, kecuali dipindahkan]
Database di-snapshot tiap minggu ke `data/backups/db/` (`VACUUM INTO`, tiap salinan dicek
integritasnya), dan saat boot kecuali yang terbaru umurnya belum seminggu, di samping persona pack
dan vault memori; `daemon.backup_keep` (4) menentukan berapa yang disimpan. Snapshot yang dibuat sebelum
migrasi, `nouride-<waktu>-before-<n>.db`, disimpan di luar rotasi itu: itulah jalan kembali dari sebuah
upgrade. Secara default semuanya ada di disk yang sama dengan aslinya; `daemon.backup_dir` memindahkan
yang terjadwal ke disk lain, misalnya flashdisk USB di box yang jalan dari kartu SD.
`nouride db backup` membuat satu saat itu juga dan `nouride db restore <file>` mengembalikannya, dengan
daemon berhenti; `tar` atas `.nouride/` dengan daemon berhenti adalah salinan lengkap untuk ditaruh di
tempat lain. [Backup →](/id/docs/manual/maintenance/#backup)
:::

## Secret

File config memuat **nama** secret. Nilainya ada di tempat lain, dan diselesaikan pada saat dipakai:

```
api_key = "nougate"   →   $NOUGATE
                      →   $NOURIDE_SECRET_NOUGATE
                      →   data/secrets.enc
```

Environment menang atas store, jadi platform container selalu bisa mengunci sebuah nilai. Store adalah
yang ditulis dashboard, itulah sebabnya menambahkan bot token gak butuh redeploy.

Inilah yang membuat `config.toml` aman untuk di-commit, dicetak, dan ditampilkan di browser.

```bash
nouride secret                                 # nama dan untuk apa masing-masing: nilai gak pernah dicetak
printf '%s' "$TOKEN" | nouride secret set telegram-nouva --stdin --field site=telegram.org
nouride secret rm telegram-nouva
```

`--value <v>` ada dan CLI menyatakan terang-terangan biayanya: nilainya berakhir di riwayat shell kamu.
Pipe saja.

**Terenkripsi saat disimpan (0.8.19).** `secrets.enc` adalah seluruh penyimpanannya, AES-256-GCM, dengan kunci yang
diturunkan dari `NOURIDE_ENCRYPTION_KEY`. Nilai enkripsi itu ada pada seberapa jauh kuncinya dari datanya, jadi kuncinya
disimpan di luar instalasi di mana pun ada tempat di luarnya: di Linux, `install.sh` menaruhnya di
`/etc/nouride/nouride.env` milik root, yang dibaca systemd sebelum menjalankan service-nya, dan perintah `nouride`
menyerahkannya ke apa yang dijalankan root lewat perintah itu; di Mac, `~/.config/nouride/nouride.env`; container
mengambilnya dari environment-nya, atau dari file yang disebut di `NOURIDE_ENCRYPTION_KEY_FILE`. Jadi salinan
`.nouride/` gak membawa kunci, dan gak bisa membuka penyimpanannya. Instalasi yang cuma di-update dapat kunci buatan
daemon, satu baris di `.env` instalasi, yang dipindahkan keluar apa adanya oleh `install.sh` berikutnya; container yang
gak diberi kunci menyimpan satu di `.nouride/`. Di kedua kasus, `nouride doctor` bilang di mana kuncinya.

Penyimpanan itu mencatat fingerprint kuncinya, jadi kunci yang salah disebut sebagai kunci yang salah, bukan dikira
kerusakan, dan daemon gak pernah membuat kunci baru di atas penyimpanan yang butuh kunci lain: ia menolak start dan
menyebut dua jalan keluarnya, kunci itu, atau `nouride secret restore` dengan password backup. Kuncinya dikeluarkan dari
environment daemon begitu dibaca, jadi gak ada yang dijalankan daemon yang mewarisinya. Yang gak dilindungi enkripsi
ini, terus terang saja: root di mesin itu, daemon yang sedang jalan (ia memegang nilai-nilainya untuk memakainya), image
utuh sebuah disk tanpa TPM, dan blok yang ditinggalkan `secrets.json` lama yang belum terenkripsi di disk.

**Untuk apa sebuah secret (0.8.19).** Tiap secret bisa membawa field dengan nama pilihanmu sendiri: situs asalnya,
username atau email pasangannya, apa yang memakainya. Field itu bukan rahasia: ditampilkan di samping namanya di halaman
Secrets dashboard, oleh `nouride secret`, dan ke agent, yang mengisinya saat menyimpan secret. Teks yang bentuknya
seperti key atau password ditolak di situ. Nilai sebuah secret cuma bisa diganti, gak pernah ditampilkan.

Penyimpanan ini masuk ke snapshot hanya dalam keadaan tersegel (0.8.18), dengan password backup yang diatur di halaman
Secrets dashboard atau lewat `nouride secret seal --stdin`; `[daemon] backup_seal` menyimpan separuh publik dari kunci
yang diturunkan dari password itu. Tiap snapshot config lalu memuat `secrets.sealed` (X25519 dan AES-256-GCM, kuncinya
dari scrypt), yang bisa ditulis daemon tapi gak bisa dibacanya; `nouride secret unseal` membukanya dengan password itu.
Sejak 0.8.19, salinan di sebelah penyimpanan, `data/secrets.sealed`, dibuat ulang di tiap perubahan, dan
`nouride secret restore --stdin` mengembalikannya dengan kunci instalasi ini: untuk kunci yang hilang, atau instalasi
yang dipindah tanpa kuncinya. Tanpa password backup, gak ada snapshot yang memuat secret.

## Apa yang kedaluwarsa, dan kapan

```toml
[retention]
session_days     = 30    # percakapan, dan lampiran yang menjadi bagiannya
audit_days       = 30    # audit log dan catatan pemakaian
job_log_days     = 3     # output perintah background
tool_output_days = 2     # hasil tool yang tumpah ke disk
scratchpad_days  = 3     # direktori sekali pakai tiap agent
log_days         = 3     # tabel log milik daemon sendiri (0 mematikannya)
```

Dua di antaranya layak dipahami.

**`job_log_days`** gak bisa berarti "hapus saat job selesai", karena agent mungkin masih memegang path
yang diberikan tool kepadanya.

**`scratchpad_days`** mencakup `workspace/private/<agent>/.scratchpad/`: direktori sekali pakai tempat
agent diminta menaruh artefak sementara: screenshot yang sedang menuju dikirim, unduhan yang sedang
menuju dikonversi. `$TMPDIR` milik sebuah perintah menunjuk ke sana. Menghapus di dalamnya gak pernah
masuk daftar tetap, jadi agent bisa membereskan sendiri. Ia disapu oleh
timer, bukan di akhir giliran, karena pesan berikutnya biasanya justru tentang file yang barusan
dikirim.

"Skill mana yang belum pernah dibaca siapa pun" gak bergantung pada `audit_days`: kapan tiap skill
terakhir dibaca disimpan terpisah dari baris audit yang mencatatnya (`skill_reads`), selama skill itu
ada.

## Riwayat percakapan

Percakapan disimpan per agent, per chat, per instance gateway. `max_conversation_turns` (200) membatasi
seberapa banyak disimpan.

Ketika konteks memanjang, daemon **memadatkan** alih-alih memotong: bagian lama diringkas sekali,
ringkasannya disimpan, dan giliran paling baru tetap apa adanya. Sebuah percakapan boleh memakai
`max_context_ratio` (0,8) dari jendela model, dan pemadatan dimulai di `compact_at_ratio` (0,8) dari
itu, atau di `compact_at_tokens` (160k untuk kebanyakan model) kalau itu lebih dulu tercapai. Isi
persis yang sudah dipadatkan tetap bisa dibaca ulang lewat `memory_read`.

`/new` memulai percakapan baru. Yang selamat: `MEMORY.md`, entri People, dan vault memori
(percakapan yang barusan ditinggalkan dipotong menjadi episode, dan fakta yang dipelajari tetap ada di
profil).

## Memori

Tiap percakapan menjadi sebuah **episode**, file Markdown di vault memori; nightly pass, begitu
dinyalakan, meringkasnya dan menyimpan yang dipelajarinya tentang orang-orang di dalamnya. Vault adalah
sumber kebenaran dan indeks SQLite-nya, yang dibangun di atas FTS5, dibangun ulang dari situ. Cara kerja
semuanya (siapa boleh membaca apa, apa yang sampai ke prompt, bagaimana pencarian mengurutkan) ada di
halamannya sendiri: [Memori](/id/docs/architecture/memory/).

Rollover cuma mengosongkan konteks sebuah percakapan; memori dipotong dari log giliran, jadi gak ada
yang hilang:

```toml
[rollover]
mode = "none"        # none | daily | idle
```

`daily` mengosongkan percakapan yang *dimulai* sebelum batas hari ini; `idle` mengosongkan yang gak
disentuh selama sekian lama. Itu seluruh bedanya: chat yang dipakai sepanjang hari tetap basi di batas
berikutnya, dan chat yang dimulai sejam lalu gak idle seberapa pun tuanya chat itu.

## Kesehatan

Daemon memeriksa sisa disk-nya sendiri tiap menit dan *memicu alert* di bawah 1 GB alih-alih cuma
mencatat; `/health` melaporkan degraded begitu WAL lewat 100 MB. Sampai 0.8.0 ini `[health]`; gak ada
yang pernah mengubahnya, jadi sekarang nilainya tetap, dan tabel `[health]` yang masih ada di
`config.toml` disebut di peringatan lalu diabaikan. Ini daemon mengawasi dirinya sendiri: gak
ada di sini yang membangunkan agent. Cron job yang melakukan itu, begitu juga background job milik
agent sendiri, saat job itu selesai atau sudah lama diam.
