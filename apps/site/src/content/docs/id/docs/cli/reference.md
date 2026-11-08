---
title: Referensi perintah
description: Setiap perintah nouride, dikelompokkan menurut cara orang mencarinya.
---

```bash
nouride help              # daftar yang sama, dari binary-nya sendiri
nouride <perintah> --help # cuma baris-baris perintah itu
nouride version
```

Dua jenis perintah, dan pembagiannya penting:

- **`nouride start`** menyalakan daemon di proses ini.
- **Selain itu** berbicara ke daemon yang *sedang berjalan* lewat control API.

CLI yang menyalakan daemon-nya sendiri untuk menjawab `nouride status` akan melaporkan proses yang gak
dipakai siapa pun, dan `nouride chat` akan berbicara dengan salinan kedua yang punya koneksi gateway
sendiri, dua bot Telegram yang polling satu token.

Sejumlah kecil perintah gak butuh daemon sama sekali: `help`, `version`, `setup`, `doctor`, `service`,
`policy`, `config`, `stop`, `db`, `users reset`, `pkg`, `tools run`, dan `gateway rename`.

## Kode keluar, `--json` dan flag

| Kode keluar | |
|---|---|
| 0 | selesai |
| 1 | gagal: daemon menolak atau gak bisa dihubungi, atau `doctor` menemukan masalah |
| 2 | permintaannya salah: perintah atau aksi yang gak dikenal, flag atau kata yang gak dibaca perintah itu, argumen yang hilang atau salah bentuk |

Setiap perintah menerima `--json` dan mencetak satu objek di stdout alih-alih baris,
`{"ok": …, "data": …, "error": …, "hint": …}`, dengan `data` berisi jawaban perintah itu. `chat`, `start`,
`setup` dan `logs -f` memegang terminal alih-alih menjawab sekali, jadi menolaknya.

Nilai sebuah flag ditulis sesudahnya atau sesudah `=`: `--limit 5` sama dengan `--limit=5`. Sesudah `--`
tunggal, gak ada lagi yang dianggap flag, jadi `nouride policy check -- ls --help` menanyakan `ls --help`.
Secret dibaca dari stdin dengan `--stdin`.

Ejaan lama yang masih dibaca 0.7.x ditolak sejak 0.8.0, kode keluar 2, sambil menyebut yang harus ditulis:
`--value-stdin`, `--key-stdin` dan `--token-stdin` jadi `--stdin`; `--isolated` jadi `--session isolated`;
`approvals approve` jadi `approvals allow-once`; `people forget` jadi `people remove`.

Flag yang gak dibaca sebuah perintah ditolak, kode keluar 2, dan sejak 0.7.11 begitu juga kata yang gak
dibacanya: `reload` sesudah `nouride agents` dulu dibuang dan daftar agent ditampilkan; sekarang ia ditolak
sebelum daemon ditanya apa pun, dan diarahkan ke `nouride agent reload`, perintah yang menerimanya. Perintah atau
aksi yang salah ketik dijawab dengan yang paling mungkin dimaksud, tetap kode keluar 2: *missions* sebagai perintah
dijawab *Did you mean `nouride mission`?*, dan *lst* sesudah `nouride jobs` dijawab *Did you mean `nouride jobs list`?*

:::note[Cara agent menjangkau CLI]
Agent yang memegang tool `nouride` bisa menjalankan perintah-perintah ini lewat tool itu, dan hanya
lewat itu: `exec` menolak binary milik instalasi ini sendiri. Tool itu selalu menjalankan binary
instalasi ini dari direktori instalasinya, jadi agent gak pernah membaca control token, dan setiap
panggilan melewati gerbang yang sama dengan `exec`: approval, grant dan daftar tetap tetap berlaku.
Agent bisa diberi permukaan kendali daemon tanpa diberi shell umum.
:::

## Di mana ia mencari

CLI menemukan instalasinya dengan cara yang sama seperti daemon: `$NOURIDE_CONFIG`, lalu
`$NOURIDE_HOME`, lalu direktori kerja, lalu direktori tempat binary-nya terpasang. Jadi `nouride` yang
sudah terpasang jalan dari direktori mana pun, dan direktori yang punya `.nouride/` atau `config.toml`
sendiri menang atasnya. Untuk autentikasi ia membaca `data/.control-token` dari instalasi itu. Dua
variabel lingkungan mengarahkannya ke tempat lain sepenuhnya:

```bash
export NOURIDE_URL=https://nouride.example.com
export NOURIDE_TOKEN=<isi data/.control-token mesin itu>
```

---

## Menjalankan daemon

```bash
nouride start                     # jalankan engine di proses ini
nouride stop                      # hentikan daemon instalasi ini (tanpa token)
nouride restart                   # restart setelah tidak ada yang berjalan; --now tanpa menunggu
nouride restart --wait            # dan kembali setelah ia hidup lagi; keluar 1, dengan alasannya, kalau tidak
```

`stop` adalah satu-satunya perintah yang mencapai daemon tanpa control API: ia membaca file lock lalu
mengirim sinyal, jalur yang tetap bekerja ketika justru HTTP server yang macet.

`restart` menunggu seperti `update --start`: sampai tidak ada giliran yang berjalan atau mengantre
dan tidak ada approval yang menunggu, paling lama sepuluh menit, dan sampai tidak ada background job
yang bekerja, berapa lama pun itu. Ia menyebutkan job yang ditunggunya. `--now` langsung restart dan
menghentikan job-job itu. Tombol **Restart** di Home dashboard dan `/daemon-restart` di chat
melakukan hal yang sama.

Agent wajib memberi `--then "<tindak lanjut>"` (atau `--no-then`). Perintah ini mengakhiri percakapan
tempat ia dijalankan, jadi giliran tindak lanjutnya dibuat *sebelum* layanannya turun, dan restart
yang kacau tetap disambut oleh yang memintanya. Tindak lanjutnya jalan `--in` detik (bawaan 10)
setelah restart-nya sendiri, bukan setelah perintahnya. Kalau dijalankan agent, ia kembali ke
percakapan yang sama; dari terminal, sebutkan tujuannya dengan `--gateway`, `--chat` dan `--agent`.
Orang di depan terminal tidak perlu kedua flag itu.

Kalau gak ada yang mensupervisi daemon, `restart` menolak alih-alih diam-diam menghentikan kamu.
`--force` tetap menghentikannya.

`--wait` mengikuti restart lewat `/health`: masih menyelesaikan yang berjalan, berhenti, menyala dan di
langkah mana, hidup lagi. Ia menyerah setelah dua belas menit, dan membedakan proses lama yang masih
menunggu sebuah background job, yang gak punya batas waktu, dari proses baru yang gak kembali.

## Menyiapkan

```bash
nouride setup                     # interaktif
nouride setup --yes --provider anthropic --api-key-from-env ANTHROPIC_API_KEY --agent nouva
```

Flag: `--provider`, `--base-url`, `--api-key-from-env`, `--agent`, `--name`, `--model`, `--prompt`,
`--headline`, `--config`, `--yes`. Sengaja gak ada `--api-key`.
[Menyalakan pertama kali →](/id/docs/start/first-run/#kalau-hanya-bisa-lewat-ssh)

## Melihat keadaannya

```bash
nouride status                    # satu layar: agent, gateway, antrean
nouride doctor [--fix]            # mendiagnosis setup yang belum jalan; --fix mempersempit mode file secret
nouride logs [-n N] [-f] [--level <level>] [--component <nama>]   # log daemon sendiri: jalan tanpa journal, dan jarak jauh
nouride audit [limit]             # aksi teraudit terbaru
nouride sessions [limit]          # percakapan tersimpan
nouride turns [--agent <id>] [--limit N]   # giliran terbaru, beserta biayanya
nouride turns show <id>           # satu giliran utuh: tiap panggilan model (token, biaya, latensi, retry), langkah, tool call
nouride events [--turn <id>] [-f] # apa yang dikerjakan giliran saat dicatat: langkah, jawaban, tool call, panggilan model
nouride jobs                      # yang sedang jalan, dan lima terakhir yang selesai
nouride jobs --all                # semua job yang disimpan
nouride jobs log <id>
nouride jobs kill <id>
nouride mission                   # misi: yang butuh kamu dulu, lalu yang jalan, lalu lima terakhir yang selesai
nouride mission show <id>         # satu misi lengkap: tujuan, cek, checklist, batas, laporan
nouride mission stop|continue|accept <id> [teks]
nouride mission answer <id> <jawaban>
nouride mission tell <id> <kata>  # pesan untuknya selagi bekerja: dibaca sebelum langkah berikutnya
nouride mission delete <id>       # hapus misi yang sudah selesai: percakapan, checklist dan foldernya sendiri (--force: termasuk kerja yang belum di-commit)
```

## Bicara dengannya

```bash
nouride chat [agent]              # chat interaktif, tanpa bot token
```

## Agent

```bash
nouride agents                    # daftar: waiting for you, working, asleep, atau idle
nouride agents scan               # CLI coding untuk agent eksternal yang ada di box ini, beserta versinya
nouride agents login <id>         # login CLI agent eksternal: jalan di box, dijawab dari sini
nouride agents update <cli> [<versi>]   # ke versi terbaru yang sudah dites dengan Nouride ini, atau kembali ke <versi>
nouride agent sleep <id>          # gak menerima kerjaan sampai wake, restart pun gak membangunkannya (pause juga bisa)
nouride agent wake  <id>          # (resume juga bisa)
nouride agent reload <id>
nouride agent enable  <id>        # ditulis ke config.toml, jadi bertahan setelah restart
nouride agent disable <id>
nouride agent external <id> <cli> [--profile <nama>]   # CLI coding yang menjawabnya, bukan model-nya
nouride agent internal <id>       # model-nya menjawab lagi
nouride agent skill-root add <id> <path>   # dia mengambil skill di .agents/skills project itu sebagai miliknya
nouride agent skill-root rm  <id> <path>
nouride acp [--agent <id>]        # agent di Zed atau editor ACP lain; editor yang menjalankan ini
```

`agents scan` mengecek ulang tiap kali, dan mencetak tiap CLI beserta perintah yang dijalankan Nouride dan versi
perintah itu: versi adapter ACP-nya (`claude-agent-acp 0.97.0`), bukan versi CLI-nya sendiri. Di bawah tiap CLI
bawaan dia bilang posisi versi itu dibanding versi-versi yang sudah dites dengan Nouride ini dan versi terbaru yang
sudah rilis, yang dia tanyakan ke registry npm paling sering sehari sekali; `nouride doctor` bilang hal yang sama. `agents login`
menjalankan login CLI di box, di profil milik agent itu sendiri, dan menampilkan di sini apa yang dicetaknya; baris yang
kamu ketik jadi input berikutnya, dan Ctrl-D menghentikannya. `agent external` dan `agent internal` urusan admin,
sama seperti login. `acp` dijalankan oleh editor, bukan diketik: dia bicara Agent Client Protocol lewat stdin dan
stdout, dan tanpa `--agent` orchestrator yang menjawab.
[Agent eksternal →](/id/docs/manual/external-agents/)

## Gateway

```bash
nouride gateway [list]
nouride gateway restart <id> --then "<tindak lanjut>"   # atau --no-then, kalau kamu mengawasinya sendiri
nouride gateway add --platform <p> --name <n> --agent <id> --stdin
nouride gateway rm <id>
nouride gateway rename <lama> <baru> [--apply]     # daemon harus BERHENTI
```

`gateway restart` ikut aturan yang sama dengan `nouride restart`: me-restart gateway tempat sebuah
percakapan masuk berarti mengakhirinya, jadi tindak lanjutnya dibuat duluan. `gateway add` tanpa flag
mencetak sisanya (`--token-secret`, `--session-dir`, `--disabled`); gateway barunya tersambung pada
restart berikutnya.

`rename` menulis ulang config sekaligus database yang sedang dibuka daemon, itu sebabnya ia menolak
jalan selama daemon hidup, dan sebabnya ia satu-satunya perintah gateway yang gak lewat control API.
Tanpa `--apply` ia cuma melaporkan apa yang akan diubah.

## Snapshot database

```bash
nouride db backup                # ambil sekarang, diperiksa sebelum disimpan
nouride db list                  # terbaru dulu
nouride db verify [file]         # periksa satu snapshot, atau database yang hidup
nouride db restore <file>        # daemon harus DIHENTIKAN
nouride db adopt                 # terima skema build ini untuk database ini; daemon DIHENTIKAN
```

`nouride db` tanpa apa-apa mencetak baris-baris ini dan keluar dengan 0, sama seperti `nouride config`
tanpa apa-apa (sejak 0.7.11).

Daemon mengambil satu tiap minggu, dan saat boot kecuali yang terbaru umurnya belum seminggu,
menyimpan `backup_keep` di `data/backups/db/`, atau di `[daemon] backup_dir`, yang juga dibaca oleh
`list` dan `restore`. Semuanya
lokal, bukan panggilan API, dan sengaja dikelompokkan: `restore` menggantikan file yang dipegang
daemon yang sedang jalan, jadi ia gak bisa lewat control API, dan memecah kelompoknya berarti satu
perintah yang paling dibutuhkan jam tiga pagi berperilaku gak seperti yang di sebelahnya.

Snapshot itu satu file SQLite biasa, jadi pemulihannya sama sekali gak butuh perintah ini. Yang
ditambahkan `restore` adalah menolak jalan saat daemon hidup, dan memindahkan database yang
digantikannya ke `nouride.db.replaced-<timestamp>` supaya pilihan yang salah bisa dibatalkan. Snapshot
dari versi lama itu milik versi tersebut: pasang versinya dulu sebelum start, atau build ini akan
meng-upgrade database-nya lagi. Snapshot dari sebelum 0.8.0 ditolak, tanpa ada yang diubah (sejak
0.8.1): versi ini gak mau start di atasnya. `restore` milik 0.8.0 bisa mengembalikannya, dan start
0.8.0 sekali akan membawanya ke bentuk terbaru.

`adopt` menjawab satu penolakan saat boot: migrasi yang sudah diterapkan ke database bukan migrasi yang
ada di build ini. Jalankan hanya kalau build ini memang yang benar, misalnya setelah squash; pesan
penolakannya menyebut jalan keluar yang lain.

## Password pertama yang hilang

```bash
nouride users reset              # semua akun dashboard dihapus; daemon harus DIHENTIKAN
```

Sejak 0.7.11. Ia mengambil snapshot database, mengosongkan tabel akun dan mencatat reset-nya di audit
log, lalu menyebut snapshot itu (`nouride db restore` mengembalikannya) dan tiap akun yang dihapusnya.
Start berikutnya membuat admin pertama lagi dan mencetak password-nya, atau memakai
`INITIAL_ADMIN_USERNAME` dan `INITIAL_ADMIN_PASSWORD` dari `.env` instalasi kalau keduanya di-set. Seperti
`db restore`, ia menolak jalan selama ada daemon yang jalan di direktori data ini.
[FAQ: password pertama terlewat →](/id/docs/reference/faq/)

## Provider dan secret

```bash
nouride provider [list]
nouride provider add <nama> --kind openai|anthropic --url <base> --stdin
nouride provider rm <nama>

nouride secret [list]             # nama dan untuk apa masing-masing: nilai gak pernah dicetak
nouride secret set <nama> --stdin [--field nama=teks]
nouride secret field <nama> nama=teks [--remove nama]
nouride secret rm <nama>
nouride secret seal --stdin       # passphrase backup: snapshot config memuat secret, disegel dengannya
nouride secret seal --off         # secret gak masuk snapshot
nouride secret unseal <file> --stdin --out <path>
nouride secret restore [<file>] --stdin    # secret kembali dari salinan yang disegel: kunci hilang, instalasi dipindah
nouride secret decrypt --out <path>        # penyimpanan dalam format versi sebelum 0.8.19, untuk jalan kembali
```

`provider add` mengecek key-nya ke endpoint sebelum menyimpan; `--no-probe` melewati itu. Tanpa key, ia
memakai key yang sudah tersimpan sebagai `<nama>_api_key`. `secret rm` menghapus secret di mana-mana: ia
juga keluar dari `exec_secrets` semua agent, kecuali environment masih menyetelnya.

`--value <v>` ada, begitu juga `--key` dan `--token`, dan CLI menyatakan biayanya: nilainya berakhir di
riwayat shell kamu dan di audit log.

`--field` dan `secret field` (0.8.19) menyebut untuk apa sebuah secret: situsnya, username atau email pasangannya, apa
yang memakainya, dengan nama pilihanmu sendiri. `--field` bisa diulang, satu per field; `secret field` mengisi beberapa
sekaligus dan `--remove` membuang satu, nilai secret-nya dibiarkan apa adanya. Isinya bukan rahasia: `nouride secret`,
dashboard, dan para agent menampilkannya di samping namanya, dan teks yang bentuknya seperti key atau password ditolak.

`secret seal` (0.8.18) membaca passphrase minimal dua belas karakter dari stdin dan cuma menyimpan apa yang dipakai
untuk menyegel, lalu langsung mengambil snapshot config supaya kamu bisa mengecek bahwa ia terbuka; halaman Secrets di
dashboard mengatur password backup yang sama. Simpan passphrase-nya di tempat lain selain box: gak ada apa pun di box
yang bisa membuka snapshot itu. `secret unseal` membuka `secrets.sealed` dari sebuah snapshot ke file dengan mode 0600.
Ia gak butuh daemon, gak pernah mencetak nilai, dan gak pernah menimpa file yang sudah ada.

`secret restore` (0.8.19) mengembalikan secret dari salinan yang disegel dengan passphrase itu, `data/secrets.sealed`
kecuali kamu menyebut milik sebuah snapshot, terenkripsi dengan kunci instalasi ini: untuk kunci yang hilang, atau
instalasi yang dipindah tanpa kuncinya. Jalankan dengan Nouride dihentikan; penyimpanan yang gak bisa dibukanya disimpan
terpisah, gak pernah ditimpa. `secret decrypt` (0.8.19) menulis penyimpanan dalam bentuk yang dibaca versi sebelum
0.8.19, untuk jalan kembali ke versi itu. Keduanya jalan di mesin itu tanpa daemon. Di Linux, jalankan sebagai root
(`sudo nouride …`): kunci penyimpanan adalah file milik root, dan launcher-nya menyerahkan kunci itu ke CLI.
[Backup →](/id/docs/manual/maintenance/#backup)

## Approval, grant dan policy

```bash
nouride approvals                              # apa yang menunggu
nouride approvals allow-once   [id]
nouride approvals allow-always [id]
nouride approvals deny         [id]

nouride grants [--all]                         # izin permanen; --all ikut menampilkan yang dicabut
nouride grants revoke <id|--all> [--agent <id>]

nouride policy                                 # apa yang selalu bertanya, apa yang gak pernah
nouride policy check <perintah…>               # apakah ini akan ditahan? Menjawab tanpa menjalankan
```

`policy check` bekerja saat daemon mati, yang justru saat orang sedang mendiagnosis penolakan.

## Akses dan orang

```bash
nouride access [pending|approved|denied|blocked]  # siapa yang boleh bicara dengan para agent
nouride access approve <kode> [--me | --as <key> | --new "<nama>"]
nouride access allow <gateway:sender> [--name "<nama>"]  # masuk sebelum minta, tampil di Approved
nouride access deny|block <gateway:sender>       # tidak selama sehari · tidak sampai di-unblock
nouride access revoke|reset|unblock <gateway:sender>
nouride access mode [open|allowlist|pair]      # lihat atau ganti, tanpa restart

nouride people
nouride people set <key|platform:akun> --name <nama> [--note <catatan>]
nouride people remove <key|platform:akun>
```

`approve` juga bisa menyatakan siapa pengirimnya, supaya semua agent mengenalnya dengan nama: kamu
sendiri (`--me`), orang yang sudah dikenal (`--as <key orang>`), atau orang baru (`--new "<nama>"`).

`deny` mengabaikan mereka selama sehari (`[security.access] deny_cooldown_ms`), lalu pesan dari mereka
jadi permintaan baru; `reset` mengakhiri masa tunggu itu sekarang. `block` berlaku sampai `unblock`.
Masing-masing hanya menjawab status miliknya: `deny` untuk permintaan pending, `revoke` untuk yang
sudah disetujui, `reset` untuk penolakan, `unblock` untuk block. Jadi `revoke` atau `deny` pada
pengirim yang di-block ditolak, bukan malah membuka atau melunakkan block-nya.

## Penjadwalan

```bash
nouride cron [--all]
nouride cron add --name <n> (--at 2h | --every 15m | --cron "0 9 * * *") \
  --gateway <id> --chat <id> --agent <id> [--message <prompt> | --text <pesan> | --command <sh> | --mission <goal>] \
  [--then agent] [--session fresh|isolated|chat] [--tz <zona>] [--quiet] [--keep]
nouride cron update <id> [--name …] [--at|--every|--cron …] [--tz <zona>] [--text|--message …] [--agent <id>]
nouride cron run|runs|enable|disable|rm <id>

nouride webhook
nouride webhook add --name <n> --agent <id> --gateway <id> --chat <id> --message <prompt>
nouride webhook rotate <id>                    # URL baru; yang lama berhenti bekerja
nouride webhook test <id>                      # apakah panggilan dari internet sampai
```

Webhook adalah job yang sama, pakai `nouride cron` untuk `rm`, `enable`, `disable`, `run` dan `runs`.
[Cron & webhook →](/id/docs/cli/cron/)

## Skill

```bash
nouride skills [agent] [-v]       # apa yang ditawarkan ke agent, dan kapan tiap skill dibaca
nouride skills --all              # seluruh kumpulan: siapa yang menyalakannya, dan software yang kurang
nouride skills on|off <skill> <agent>
nouride skills search <kueri>     # skills.sh, ClawHub dan indeks well-known
nouride skills install <sumber>   # owner/repo, URL, clawhub:slug… - masuk sebagai draft
nouride skills drafts             # apa yang diusulkan para agent
nouride skills draft <id>         # satu draft utuh, beserta giliran asalnya
nouride skills approve|deny <id>
```

## Memori

```bash
nouride memory                                 # nightly pass, fakta, pencarian: setelan saat ini
nouride memory set <kunci> <nilai>             # pass | pass_at | pass_per_night | pass_model | facts | …
nouride memory episodes [kata] [--agent <id>] [--person <key>] [--tag <tag>] \
  [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--status raw|summarized|compacted] [--limit N]
nouride memory show <episode>                  # satu percakapan, utuh
nouride memory pass                            # jalankan nightly pass sekarang
nouride memory proposals                       # yang diusulkan pass dan menunggu kamu
nouride memory approve|deny <id>
nouride memory changes [--person <key>]        # apa yang diubah memori, dan kenapa
nouride memory failed                          # percakapan yang gagal diarsipkan pass
nouride memory retry [<episode>]               # coba lagi di pass berikutnya
nouride memory undo <person|shared>            # kembalikan profil satu versi
nouride memory forget <person> [--anonymize]   # hapus seseorang untuk selamanya, atau hanya sembunyikan namanya
nouride memory tags                            # tag menurut pemakaian, dan berapa yang hanya di satu percakapan
nouride memory tags tidy [--apply] [--only merge,trim,cap,R5]   # pratinjau perapian; --apply menjalankannya (R5 hanya jika disebut)
nouride memory tags suggest                    # pendapat model soal tag yang semakna, gak diterapkan
nouride memory tags merge <tag…> --into <tag>  # gabung tag secara manual, dicatat seperti perapian
nouride memory tags undo                       # kembalikan perapian terakhir
nouride memory reindex                         # bangun ulang indeks dari vault
nouride memory embed                           # vektor untuk pencarian semantik
```

`pass_model` menerima `<provider>/<model>`, dan `-` mengembalikannya ke model milik tiap agent. Model itu
juga meringkas percakapan panjang kecuali `[llm.context] summary_model` diisi; `nouride doctor` memberi tahu
kalau ia gagal.
[Memori →](/id/docs/architecture/memory/)

## Budget

```bash
nouride tool-budget                            # tool round-trip yang boleh dipakai satu balasan
nouride tool-budget <n>                        # default daemon
nouride tool-budget --agent <id> <n|follow>
nouride turn-budget                            # detik yang boleh dipakai satu balasan
nouride turn-budget <detik>
nouride turn-budget --agent <id> <detik|follow>
```

## MCP

```bash
nouride mcp                                    # library, agent tempat tiap server menyala, dan tool-nya
nouride mcp add --name <nama> (--command <exe> | --url <url>) [--stdin] [--agent <id> …]
nouride mcp enable|disable <nama> --agent <id> # saklar satu agent; --env-secret, --stdin atau --own-login memberinya kredensial sendiri
nouride mcp tools <nama> --agent <id> [--only <tool,…> | --all]   # tool mana dari server itu yang dipunya agent
nouride mcp rm <nama> [--agent <id>]           # keluarkan dari library, atau dengan --agent cuma matikan untuk agent itu
nouride mcp login|logout --server <nama> [--agent <id>]
```

Server ditambahkan sekali, ke library instalasi, lalu dinyalakan per agent (sejak 0.7.19); tiap perubahan memuat ulang
agent yang terkena, jadi tidak ada yang restart. `mcp add` tanpa flag mencetak sisanya: `--arg` (sekali per argumen),
`--cwd`, `--sse`, `--header`, `--env-secret`, `--per-agent` dan `--from`.

Nouride juga bisa menjadi server MCP untuk tool lain (Claude Code, Cursor), menyajikan memori sebagai
seseorang:

```bash
nouride mcp-server                             # on/off, dan token yang sudah diterbitkan
nouride mcp-server on|off
nouride mcp-server token create --person <key> --agents <id,id> --label <client> \
  [--scopes memory,memory:write,personas] [--ttl <hari>]
nouride mcp-server token list|revoke <id>
```

Token berhenti berlaku setelah `--ttl` hari, 90 kalau gak disebut; `--ttl 0` gak pernah kedaluwarsa.
Token yang dibuat sebelum 0.7.10 gak punya akhir: cabut lalu buat yang baru untuk memberinya batas.

## Konfigurasi

```bash
nouride config check [file]       # apakah konfigurasi ini akan start? Tidak ada yang dijalankan
nouride config schema [bagian]    # setiap kunci yang valid, sebagai JSON Schema
nouride config explain <path>     # mis. nouride config explain security.web.search_endpoint
```

`check` keluar dengan 1 kalau pack agent yang aktif gak bisa dimuat (sejak 0.7.11): daemon tetap bisa
start, tapi tanpa agent itu, jadi tiap pack disebut beserta alasannya. Pack yang dinonaktifkan dan gak bisa
dimuat tetap disebut, tapi gak menggagalkan apa pun.

## Update

```bash
nouride update [--check]                       # versi dan edisi ini, dan apakah ada yang lebih baru
nouride update --track latest|lts              # rilis mana yang ditawarkan ke install ini, lalu cek
nouride update --start                         # unduh, verifikasi, tukar, restart
nouride update --start --now                   # sama, tapi langsung restart
nouride update --start --then "<yang dicek sesudahnya>"   # sama, dari agent
nouride update --start --wait                  # dan kembali setelah versi baru menjawab
nouride update --rollback [--apply]            # kembali ke versi sebelum ini (daemon berhenti)
```

Melapor adalah default dan gak menyentuh apa pun. `--start` baru restart setelah gak ada yang jalan,
dengan cara menunggu yang sama seperti `restart`: paling lama sepuluh menit untuk giliran atau
approval, background job sampai selesai. `--now` gak menunggu. Dari agent, `--start` selalu minta
izin dulu dan wajib pakai `--then`.

`--rollback` menyebutkan build mana yang akan dikembalikan dan apakah database ikut kembali, ke
snapshot yang diambil update sebelum migrasi, beserta apa yang hilang karenanya. `--apply`
melakukannya, dan ditolak selama daemon jalan. Selengkapnya di
[Update](/id/docs/deployment/updating/#kalau-versi-barunya-salah).

## Paket sistem

```bash
nouride pkg                                    # nyala atau mati, dan package manager apa
nouride pkg check <install|remove|upgrade> <nama…>   # apa yang akan berubah, tanpa mengubah apa pun
nouride pkg install|remove <nama…>             # dari repositori host ini
nouride pkg upgrade [nama…]                    # tanpa nama: semua yang ada update-nya
nouride pkg refresh                            # daftar paketnya
```

Lewat service root `nouride-pkg`: di host dipasang dengan `install.sh --allow-packages` dan mati kalau
gak, di image Docker Nouride nyala kecuali `NOURIDE_SYSTEM_PACKAGES=off`. Service ini menolak apa pun di luar
aturannya. Untuk agent, `install`, `remove`, dan `upgrade` selalu minta izin, kecuali approval level-nya `trusted`.
Lihat [Paket sistem](/id/docs/deployment/system-packages/).

## Program yang dijalankan semua agent

```bash
nouride tools run -- <installer…>              # mis. sudo nouride tools run -- npm i -g @agentclientprotocol/codex-acp
```

Menjalankan installer sebagai user daemon, tanpa perlu daemon, diarahkan ke `.nouride/bin`, `lib`, dan `opt`, lalu
membuat apa yang di-install bisa dijalankan semua agent. Yang dijalankan cuma installer (`npm` atau `bun` dengan `-g`,
`pipx`, `uv tool`, `pip`, `cargo`, `go install`, `rustup`, `claude update`), dan flag yang bakal menaruh program-nya di
tempat lain, atau path di kata mana pun, ditolak. Kalau [tiap agent punya user sendiri](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri),
ini satu-satunya cara program bersama berubah: yang di-install agent sendiri masuk ke HOME-nya sendiri. Agent cuma bisa
menjangkaunya sebagai orchestrator, lewat tool `nouride`, dan selalu minta izin orang, di approval level mana pun.

## Unit service

```bash
nouride service status                         # supervisor apa yang menjalankan proses ini
nouride service install --user <u> [--dir <path>] [--kind systemd|launchd|procd] [--exec <path>] [--privileged]
nouride service uninstall [--kind systemd|launchd|procd]   # mencetak cara menghapusnya
nouride service diff                           # unit yang terpasang dibanding yang ditulis versi ini
```

`install` **menulis** file unit di sebelah instalasi kamu dan mencetak perintah untuk mengaktifkannya.
Ia gak memasang atau mengaktifkan apa pun sendiri: mengaktifkan service sistem adalah tindakan
berhak-istimewa yang mengubah host, dan CLI yang gak bisa kamu jalankan dengan aman sekadar untuk
melihat apa yang akan dilakukannya adalah CLI yang akhirnya gak kamu jalankan. `install.sh` menulis
unit-nya dengan perintah yang sama ini. `--kind procd` untuk OpenWrt: ia menulis `nouride.init` untuk
`/etc/init.d/nouride`, butuh `--privileged` karena procd menjalankannya sebagai root, dan dipilih sendiri
kalau `/sbin/procd` ada.

`diff` membandingkan unit systemd yang terpasang dengan unit yang akan ditulis versi ini, direktif demi
direktif. Update mengganti binary, bukan unit-nya: jalankan ulang `install.sh` untuk menulisnya lagi, dan
`nouride doctor` memberi tahu kapan itu perlu.

Ia menolak membuat unit yang berjalan sebagai **root**, kecuali kamu memberi `--privileged`: itu
membuang sandbox systemd supaya agent bisa mengelola host ini, dan ditujukan untuk mesin yang
didedikasikan untuknya.
