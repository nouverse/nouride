---
title: Tool, sandbox & policy
description: Apa yang bisa dijangkau agent, apa yang menghentikannya, dan di mana batas sesungguhnya.
---

Semua yang *dilakukan* agent, bukan yang dikatakannya, lewat sebuah tool. Masing-masing punya nama,
punya tipe, bisa ditahan sendiri-sendiri, dan tercatat di audit log dengan nama.

[Agent eksternal](/id/docs/manual/external-agents/) pengecualian untuk kerjanya sendiri: file, shell, dan web milik CLI
coding-nya adalah tool CLI itu, bukan tool di sini. Approval level, daftar tetap, dan `[tools]` gak menyentuhnya; yang
menyentuh adalah preset-nya, dan yang ditanyakan CLI di bawah preset itu datang ke kamu sebagai approval. Tool Nouride
yang dipinjamkan selama satu giliran jalan adalah tool di sini, ditahan dan diaudit seperti di bawah.

## Tool bawaan

| | |
|---|---|
| **File** | `read` (teks, dan PNG, JPEG, GIF atau WebP sebagai gambar), `write`, `edit`, `multi_edit`, `glob`, `grep` |
| **Perintah** | `exec` (sekali jalan), `session` (proses persisten yang bisa diketiknya), `secret_save` (simpan kredensial yang dikirim di chat dengan sebuah nama, beserta untuk apa kredensial itu, tanpa melihatnya) |
| **Web** | `web_search`, `web_fetch` |
| **Ingatan** | `memory_search`, `memory_read`, `memory_analyze`, `memory_write` |
| **Lampiran** | `attachment_read`, `send_file` |
| **Chat lain** | `send_message` (kirim ke chat yang ia kenal: chat pribadi seseorang atau grup. Percakapan di chat itu ikut menyimpannya; bertanya dulu) |
| **Orang** | `person_record`, `person_notes` |
| **Agent lain** | `delegate` (subagent), `ask_agent` (persona lain), `plan` |
| **Skill** | `skill_create`, `skill_improve`, `skill_toggle`, `skill_search`, `skill_install` |
| **MCP** | `mcp_search` (cari server di registry MCP resmi, lalu beri orangnya link untuk menambahkannya; ia sendiri gak bisa menambahkan) |
| **Dirinya sendiri** | `agent_create`, `agent_configure`, `nouride`, `update`, `session_status` |

Mana yang didapat satu agent diatur `[tools] enabled` di pack-nya. Yang gak terdaftar gak ada di
skema sama sekali, model gak tahu ia ada, dan itu disengaja: tool di dalam skema adalah janji yang
akan dicoba dipenuhi model. Beberapa ikut daemon, bukan daftar itu: `ask_agent` kalau ada agent lain
yang bisa ditanya, `attachment_read`, dan tool MCP milik agent. `skill_create` membawa `skill_search`
dan `skill_install` bersamanya, dan `send_file` membawa `send_message`.

`web_search` punya satu pengecualian yang layak diketahui. Tanpa search key sama sekali, ia jatuh ke
sumber tanpa key alih-alih menghilang, karena agent tanpa tool pencarian gak berhenti mencari: ia
menulis scraper lalu menjalankannya lewat `exec`. Ia cuma ditarik kalau backend yang kamu pilih gak
bisa jalan, misalnya SearXNG tanpa alamat, atau Exa tanpa key.

## Sejauh mana sebuah tool boleh menjangkau

Tool file dan exec sebuah agent menyelesaikan path terhadap **workspace root**-nya:

```toml
# .nouride/agents/nouva/config.toml
[workspace]
roots = ["/home/kamu/projects/thing"]
```

Kosong berarti pack-nya sendiri, workspace bersama dan direktori privatnya: aman, tapi ia gak bisa
menyentuh proyek apa pun. Beberapa direktori bisa dibaca tapi gak pernah bisa ditulis: skill yang
ditawarkan kepadanya, log job dan output tool miliknya sendiri yang tumpah ke disk, dan, untuk agent
yang punya shell, `HOME`-nya serta program terpasang di `.nouride/bin`, `lib` dan `opt`. Yang terakhir
itu cuma dibuka lewat path; pencarian tanpa path melewatinya, karena isinya kebanyakan cache.

Path di luar semua root ditolak bagaimanapun ditulis, traversal `..`, symlink dan path absolut semua
diselesaikan lebih dulu. Penolakannya menyebut cara yang berhasil: agent yang punya shell membaca file
seperti itu lewat `exec`. `nouride doctor` melaporkan root yang dideklarasikan tapi gak ada, karena
itu kasus di mana semua hal lain tampak hijau sementara setiap path ditolak.

Tool file gak pernah menulis `config.toml` milik agent itu sendiri, atau milik daemon, di level
approval apa pun. Tool, root dan approval-nya urusan kamu untuk diubah, dari dashboard atau CLI.

`.nouride/workspace/shared/` adalah tempat path relatif mendarat, dan ia dibagi semua agent dengan
sengaja. [Kenapa →](/id/docs/architecture/agents/#di-mana-agent-bekerja)

## Kredensial yang bisa dipakai agent tapi gak pernah dibacanya

Direktori kredensial sengaja **bukan** workspace root. `read`, `glob` dan `grep` gak bisa
menjangkaunya. Cuma sebuah perintah yang bisa, lewat `$NOURIDE_CREDENTIALS_DIR`, yang diberitahukan
blok harness kepada agent.

Perbedaan itu intinya. Kredensial yang sampai ke jendela konteks berarti ada di log permintaan
provider, di sesi yang tersimpan di disk, dan di apa pun yang dikatakan model berikutnya. `chmod` gak
menjangkau satu pun dari itu.

```toml
[security]
credentials_dir = ""      # kosong = <data_dir>/credentials, dibuat 0700 saat boot
```

Perintah yang menyebut file di sana, `cat .nouride/data/credentials/token.json`, adalah path
kredensial: gak pernah dianggap perintah sehari-hari, jadi `careful` menanyakannya sekali dan
`allow-always` boleh menjawab untuk perintah persis itu, dan yang dicetaknya disamarkan di semua tingkat.
`python3 sync.py`, yang script-nya sendiri membuka file itu, gak diklasifikasi. Perintah yang kamu tulis boleh memakai
kredensial; agent yang menarik kredensial ke dalam percakapan harus ditanyakan. Sejak 0.7.17 isi
file-file itu tetap disamarkan dari setiap hasil tool, termasuk script yang membuka salah satunya lalu
mencetak token-nya.

**Daemon menolak start kalau direktori kredensial jatuh di dalam root yang bisa dibaca**, sehingga
penempatan yang diam-diam membiarkan model membaca key gagal saat boot, bukan gak gagal sama sekali.

Sisi lain dari gagasan yang sama adalah `exec_secrets`: nama secret yang nilainya tiba di proses anak
sebagai variabel lingkungan saat perintah dijalankan, dan gak pernah di prompt. Kalau sebuah perintah
tetap mencetaknya, setiap hasil tool disamarkan sebelum dilihat model: nilainya, bentuk base64 dan
URL-encoded-nya, dan delapan karakter pertamanya, jadi cetakan yang berhenti di tengah juga ketahuan.
Hasilnya terbaca `[REDACTED:NAME]`.
[Approval & izin →](/id/docs/manual/approvals/#secret-yang-boleh-dipakai-agent-tapi-gak-pernah-dibacanya)

## File kredensial di dalam proyek

Proyek membawa file `.env`; `HOME` membawa `.npmrc`, `.netrc`, login CLI cloud dan kunci ssh. `read`
dan `grep` menampilkannya dengan nilai rahasianya disembunyikan: key mana yang diisi dan bagaimana
file-nya disusun, gak pernah nilainya, jadi sebuah pola gak bisa menemukan secret yang ditebak satu
karakter demi satu karakter. Perintah tetap bisa memakainya tanpa mencetaknya. Secret milik Nouride
sendiri, yaitu secret store, control token dan direktori kredensial, langsung ditolak.

Sejak 0.7.17 perintah pun begitu. Perintah yang membaca file kredensial disamarkan dari nilai-nilainya
di outputnya, jadi `cat .env` tampil seperti di `read`; `git add`, `commit` atau `push` yang akan
membawa file kredensial ditolak di semua tingkat approval, dengan menyebut file-nya; dan perintah yang
mengirimnya keluar mesin ini (`scp`, upload dengan `curl`, gist) bertanya dulu, di bawah secret
guard. Milik Nouride sendiri dijaga lebih ketat: perintah, atau baris yang diketik ke session, yang
menyebut secret store, salinannya, atau control token ditolak di semua tingkat, dan isi store, control
token, serta file di direktori kredensial disamarkan dari setiap hasil tool, bagaimanapun sebuah
perintah sampai mencetaknya.

`send_file` gak mau mengirim file kredensial, atau file teks apa pun yang memuat nilai salah satu
secret milik agent. File yang dikirim ke platform chat berangkat apa adanya, dan gak ada yang bisa
menyamarkannya di sana.

## Gerbang approval

Tool call yang ditahan memarkir giliran itu dan bertanya kepada manusia. Gak ada yang berjalan selama
menunggu, dan permintaan yang gak dijawab kedaluwarsa sebagai **penolakan**, bukan persetujuan.

Klasifier di baliknya mencari apa yang ada di daftar tetap (`config.toml` diubah, akses diberikan, daemon ini
dihentikan atau diganti, secret diganti, kredensial keluar, database, penghapusan di luar workspace,
infrastruktur dibongkar, job yang jalan tanpa ditanya, session, force-push, paket sistem mesin ini diubah, program
dipasang untuk semua agent, persona agent atau People diubah), dan gak satu pun bisa jadi izin permanen. Tingkat approval menentukan mana yang sampai ke orang. Ia *menembus pandang* eskalasi privilese, jadi
`sudo systemctl stop nouride` diklasifikasikan sebagai daemon ini dihentikan, bukan sebagai `sudo`.

Perintah yang menulis ke instalasi daemon sendiri, binary-nya atau skill bawaannya, langsung ditolak
alih-alih ditanyakan, dengan cara yang benar disebutkan: `nouride update`, atau salinan skill itu di
kumpulan skill.

:::caution[Klasifier bukan batas keamanan]
Model yang bertekad bisa memutari klasifier apa pun. Ia ada supaya pekerjaan biasa gak mengejutkan
kamu. Yang benar-benar menahan adalah service account, pengerasan unit, workspace root, dan gerbang
akses.
:::

[Model izin lengkapnya →](/id/docs/manual/approvals/)

## Daemon menolak start dalam satu konfigurasi

**Gateway aktif, sebuah agent memegang `exec`, `[security.access] mode = "open"`, dan allowlist
pengirim kosong.** Kombinasi itu adalah remote shell bagi siapa pun yang menemukan bot-nya, jadi ia jadi
kegagalan boot alih-alih peringatan di log yang gak dibaca siapa pun.

## Batas untuk satu panggilan

| | Default | |
|---|---|---|
| `tool_timeout_ms` | 30 dtk | satu tool call; `exec` boleh minta sampai 4 mnt |
| `tool_max_output_bytes` | 100 MB | output yang boleh dihasilkan satu panggilan; yang besar dialirkan ke disk dan cuma ujung-ujungnya yang ditahan |
| `approval_timeout_ms` | 5 mnt | permintaan yang gak dijawab kedaluwarsa sebagai penolakan |
| `max_tool_iterations` | 250 | tool call dalam satu giliran |
| `max_turn_duration_ms` | 1 jam | jam dinding untuk satu giliran penuh |
| `command_timeout_ms` | 10 mnt | payload `--command` terjadwal |

Dua anggaran giliran ini sengaja besar, supaya satu giliran bisa menuntaskan pekerjaan panjang seperti
yang dilakukan coding agent. Percakapan dipadatkan selagi tumbuh, dan `/stop` menghentikan giliran saat
itu juga. Tool yang gak berhenti waktu gilirannya dihentikan, lewat `/stop` atau karena waktunya habis,
diberi lima detik; setelah itu giliran berakhir tanpa menunggunya, dan hasilnya bilang tool itu mungkin
masih jalan di latar belakang. `max_turn_duration_ms` terpisah dari timeout per-permintaan dan per-tool, yang masing-masing
membatasi satu langkah. Selama sebuah giliran berjalan, chat lain tidak menunggunya, dan di chat satu
lawan satu pesan yang dikirim di tengahnya dibaca giliran itu di langkah berikutnya. Pack sebuah agent
bisa mengatur anggarannya sendiri lewat `[llm] max_tool_iterations` dan `max_turn_seconds`.

Batas kernel untuk satu perintah ada dan **mati secara default**:

```toml
[security.exec]
max_memory_mb = 0        # prlimit --as; cuma Linux
max_cpu_seconds = 0
```

Mati karena `--as` membatasi ruang alamat, bukan memori resident, dan V8 memesan ruang alamat jauh
lebih besar dari yang dipakainya, pada batas 1 GB, `tsc` gagal padahal cuma memakai 250 MB. Batas yang
cukup rendah untuk melindungi mesin kecil akan membunuh setiap build di atasnya; batas yang cukup
tinggi untuk membiarkan build jalan gak melindungi apa pun.

Kalau diisi, batas ini berlaku untuk job di latar belakang juga, bukan cuma perintah di latar depan.
Service jadi pengecualian untuk `max_cpu_seconds`: detik CPU terus bertambah selama prosesnya jalan,
jadi server akan dibunuh hanya karena berjalan. Log sebuah job disamarkan dari kredensial agent saat
ditulis, sama seperti semua yang dicetak sebuah perintah.

Yang benar-benar membantu di mesin bersama: perintah yang di-spawn agent berjalan di `nice 10`, dan unit
systemd yang dibuat membawa `MemoryHigh` lunak di 80% memori mesin dan `/tmp` privat dengan batas
ukuran, keduanya ditulis sebagai angka absolut yang dihitung saat instalasi. Clone yang terlalu besar
untuk `/tmp` lalu gagal dengan "no space", yang bisa dilihat dan dilaporkan agent, alih-alih memenuhi
RAM sampai daemon tersendat. Sejak 0.7.19 perintah-perintah itu juga berjalan di cgroup sendiri, dengan
batas di bawah plafon itu: yang melewatinya dihentikan, sendirian, dan daemon tetap menjawab.

## Instalasi tanpa root

Agent jalan sebagai akun tanpa hak khusus, jadi tujuan default setiap installer untuk instalasi global
adalah direktori yang gak bisa mereka tulisi. Tiap installer diarahkan ke `.nouride/` sebagai gantinya,
lewat pengaturan yang memang sudah dibacanya:

- `npm i -g`, `bun add -g`, `pipx install`, `uv tool install`, `go install` dan `cargo install`
  mendarat di `.nouride/bin`, tanpa root dan tanpa flag. Binary rilis masuk ke sana dengan
  `install -m 755`.
- `pip install` langsung jalan: para agent berbagi satu environment Python, `.nouride/opt/python`,
  yang tetap melihat paket Python milik sistem. Ia dibangun saat daemon start, dan dibangun ulang kalau
  Python sistem berubah.
- Setiap perintah, background job, `session` dan perintah terjadwal mendapat `PATH` yang sama:
  direktori bin, env Python bersama, direktori milik sistem, lalu terakhir `~/.local/bin` dan
  `~/.cargo/bin`, jadi gak ada yang di sana bisa menutupi program sistem.
- Shell tempat sebuah perintah jalan selalu milik sistem. `bash` yang ditaruh di direktori bin gak
  pernah jadi yang menjalankan perintah berikutnya, begitu juga `tar` yang membongkar update.
- Di tempat agent dulu berimprovisasi, error-nya kembali dengan petunjuk satu baris: Python menolak
  `pip` (PEP 668), gak ada `sudo`, binary untuk arsitektur atau C library yang salah, gak ada
  compiler, program yang belum terpasang.
- Paket sistem lewat `nouride pkg install`, kalau instalasinya mengizinkan, dan jalan sebagai
  background job supaya instalasi yang lama gak terpotong. [Paket sistem →](/id/docs/deployment/system-packages/)
- `nouride doctor` mendaftar apa yang dipasang agent, dan memperingatkan link ke dalam cache, link
  yang rusak, atau program yang menutupi program sistem seperti `git` atau `python3`.

Semua ini berlaku di tempat `HOME` milik para agent sendiri, `.nouride/home`, seperti di bawah service
dan di dalam container. `nouride start` di mesin kamu sendiri gak mengutak-atik npm dan pip kamu.

## Akses web

`web_fetch` memblokir alamat privat, LAN dan loopback secara default, dan memblokir endpoint metadata
cloud tanpa syarat.

```toml
[security.web]
allow_private_urls = false
```

Menyalakannya adalah yang membuat agent bisa memeriksa layanan yang baru saja dijalankannya,
`http://localhost:3000/health` setelah menjalankan dev server. Ia mati secara default karena di sebuah
server itu mengubah `web_fetch` menjadi pembaca setiap layanan internal di mesin itu, dan agent
mengambil instruksinya dari chat.

Atur lewat halaman **Web Search** di dashboard (di bawah Settings): pilih provider, ikuti langkah untuk mendapatkan key atau server-nya, tes, lalu simpan. `web_search` punya empat backend: Brave (butuh key, ada free tier), Exa (butuh key, pencarian yang dibuat
untuk agent AI: tiap hasil datang dengan beberapa baris dari halamannya), SearXNG (self-hosted, tanpa key),
dan fallback scraping tanpa key. Exa diatur seperti Brave, dengan key di bawah namanya sendiri:

```toml
[security.web]
search_kind = "exa"
search_api_key = "exa_api_key"   # nama secret-nya; key-nya sendiri di Secrets atau sebagai EXA_API_KEY
```

Cuma Brave, yang default, yang jatuh ke sumber tanpa key selama key-nya belum ada. Exa tanpa key membuat
agent gak punya pencarian web sama sekali, dan `nouride config check` menyebutnya.

Pada kegagalan runtime, 429, 5xx, timeout, yang utama jatuh ke fallback daripada membuat agent kehilangan
pencarian di tengah tugas. Layanan pencarian di `fallback_backends` memakai key-nya sendiri, gak pernah
key milik yang utama: Brave dari `brave_search_api_key`, Exa dari `exa_api_key`, tempat halaman Web Search
menyimpannya. Yang key-nya belum diisi dilewati, dan `nouride config check` menyebutnya. Kalau layanannya
menolak, agent diberi tahu artinya: key yang gak diterima (401), akun yang kreditnya habis (402), atau
terlalu banyak pencarian untuk saat ini (429).

Sumber tanpa key ditanya sekaligus, masing-masing dengan batas waktu 6 detik, dan pencarian kembali
sebentar setelah mesin umum pertama menjawab, jadi sumber yang macet paling banyak memakan beberapa detik,
gak menahan seluruh pencarian. Sumber mana yang ditanya dipilih oleh model, lewat `sources`:

| `sources` | menanyakan |
|---|---|
| `web` | DuckDuckGo, Bing (DuckDuckGo Lite kalau keduanya kosong) |
| `news` | Google News, edisi sesuai `lang` |
| `wiki` | Wikipedia bahasa Inggris, ditambah Wikipedia dalam `lang` |
| `forum` | Reddit, lewat filter `site:` DuckDuckGo |
| `code` | GitHub, Stack Overflow, npm, MDN, Hacker News |
| `papers` | arXiv |

Tanpa `sources`, yang ditanya `web`, `news`, `wiki` dan `forum`. `lang` menerima tag bahasa apa pun
(`en`, `id`, `ja`, `pt-BR`), dan `recent: true` menaruh berita di depan. Hasilnya digabung dan
duplikatnya dibuang, mesin umum di depan. Mesin yang menjawab bot dengan hasil yang gak
berhubungan alih-alih menolak (Bing melakukannya) dikenali karena gak satu pun hasilnya menyebut
kata dari query, dan ditinggalkan.

Pencarian gambar menumpang tool yang sama (`kind = "image"`) dan mengembalikan URL gambar langsung yang
bisa diambil `send_file`, dan itulah seluruh alur "cari gambar lalu kirim" tanpa browser di mana pun.
Cuma Brave dan SearXNG yang bisa melakukannya: Exa mengembalikan halaman, bukan gambar. Fallback tanpa key men-scrape *halaman* hasil
dan gak punya mode gambar, jadi ia menolak dan menyebut kedua pengaturannya alih-alih menyerahkan URL
halaman yang bukan gambar.

## Pembatasan laju

```toml
[security.rate_limit]
messages_per_minute = 10          # per pengirim, per gateway
cooldown_reply = "Please slow down."
```

## Teks yang gak tepercaya ditandai

Semua ini ditandai sebelum dilihat model: **hasil tool MCP dan deskripsinya**, halaman web dan hasil
pencarian, file atau gambar yang dikirim seseorang, dan isi webhook yang memicu sebuah job. Semuanya
ditulis orang yang bukan kamu.

Menandai bukan menahan. Server yang perintahnya gak akan kamu jalankan adalah server yang gak
seharusnya kamu hubungkan.

## Perintah interaktif

`exec` berjalan dengan stdin tertutup, default yang benar untuk perintah sekali jalan. Tool `session`
membuka proses persisten yang bisa diketik agent, sehingga `ssh host`, `kubectl exec -it`, `vim` dan
prompt password `sudo` semuanya terjangkau.

Itu butuh pty sungguhan, yang datang dari `script(1)`: milik `util-linux` di image Docker dan di Linux
native, dan bawaan macOS di Mac (sejak 0.7.20). Kalau gak ada `script`, session jatuh ke pipe dan
bilang begitu: cukup untuk program yang membaca stdin, gak berguna untuk apa pun yang menggambar layar.

Pekerjaan non-interaktif yang lama sebaiknya jadi background job.

## Background job dan service

`exec` dengan `background: true` memulai pekerjaan yang makan waktu lalu selesai (test suite, build,
deploy) dan langsung mengembalikan id job dan path log-nya. Giliran agent berakhir di situ dan ia
dibangunkan dengan hasilnya. Dengan `keep_working`, ia justru lanjut mengerjakan hal lain yang gak
butuh hasil itu, misalnya membetulkan file lain selagi build jalan, dan mendengar hasilnya setelah
giliran itu. Pekerjaan yang jelas lama, seperti instalasi, clone, atau build, otomatis dijadikan
background kalau agent gak menyebutnya.

Sebuah **server** gak pernah selesai, jadi ia menjadi **service**: `service: true`, atau dikenali
dengan sendirinya (dev server, static server, `docker compose up` tanpa `-d`, sebuah tunnel). Ia job
seperti yang lain (terdaftar di `nouride jobs` dan dashboard, dicatat log-nya, dihentikan dengan
`nouride jobs kill <id>`), tapi gilirannya berlanjut, jadi agent bisa memeriksa bahwa service itu
menjawab dan langsung memakainya: menyalakan preview dan mengirim link-nya di balasan yang sama.

Job yang diam selama `[jobs] quiet_after_minutes` (5) membangunkan agent-nya untuk mengabarkan bahwa
job itu masih jalan, lalu lagi setiap kali waktunya dua kali lipat. Gak ada yang dihentikan karena
diam; orangnya yang memutuskan. Jalan terlalu lama itu lain soal, dan urusan operator:
`[security] job_max_ms`, mati secara default, menghentikan job yang bukan service setelah selama itu,
dan agent-nya diberi tahu bahwa job itu gak selesai.

Perintah yang memulai sesuatu dengan `&` dan membiarkannya jalan kembali saat perintah itu selesai;
yang ditinggal jalan tetap berjalan.

Job gak bertahan melewati restart, itu sebabnya update menunggu job selesai. Service gak ditunggu:
service jalan sampai dihentikan.

## Subagent

`delegate` memulai subagent: tanpa riwayat chat, tanpa perintah slash, dan setengah anggaran iterasi.
Ia berbagi tool dan izin milik induknya, dan sampai empat bisa jalan sekaligus. Agent menunggu mereka
paling lama 45 detik; yang masih bekerja setelah itu lanjut di latar belakang sebagai job milik agent, dan
hasilnya membangunkan agent begitu datang, langsung dengan `background: true`
([Helper di latar belakang](/id/docs/architecture/agents/#helper-di-latar-belakang)). Di misi yang kerja di worktree,
`isolated` memberi tiap helper worktree dari worktree misi itu di branch sendiri, `mission/<id>-helper-<n>`, untuk
di-merge oleh misinya; di luar itu ditolak.
[Misi di dalam repo →](/id/docs/manual/missions/#di-dalam-repo)

`ask_agent` bentuk yang lain, *persona* berbeda, dengan skill, tool dan izinnya sendiri, berjalan di
belakang percakapan. Progresnya muncul berlabel namanya dan jawabannya kembali ke agent yang bertanya.
Agent yang sedang kamu ajak bicara tetap satu-satunya yang berbicara. Permintaan ditunggu paling lama
45 detik; pekerjaan yang lebih lama lanjut di latar belakang sebagai job milik agent yang meminta, dan
jawabannya membangunkan agent itu begitu datang, langsung dengan `background: true`
([Permintaan yang makan waktu](/id/docs/architecture/agents/#permintaan-yang-makan-waktu)). Beberapa agent
diminta dalam satu panggilan (`asks`, paling banyak empat): mereka bekerja bersamaan dan menjawab dalam satu
hasil, masing-masing di bawah namanya.
