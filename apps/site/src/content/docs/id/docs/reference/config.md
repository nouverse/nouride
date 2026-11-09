---
title: Konfigurasi
description: Setiap bagian config.toml, apa yang diaturnya, dan variabel lingkungan yang menimpanya.
---

Dua file, dan pembagiannya ketat.

| | |
|---|---|
| **`.nouride/config.toml`** | semua yang struktural. Aman di-commit, dicetak, dan dirender di browser |
| **`.env`** | kredensial dan nilai per-host. `0600` |

**Gak ada kredensial di `config.toml`.** Di mana satu dibutuhkan, pengaturannya menyebut sebuah
**secret**, dan nilainya diselesaikan dari environment atau secret store pada saat dipakai:

```
api_key = "nougate"   →   $NOUGATE
                      →   $NOURIDE_SECRET_NOUGATE
                      →   data/secrets.enc
```

Environment menang atas store, jadi platform container selalu bisa mengunci sebuah nilai. Store adalah
yang ditulis dashboard, itulah sebabnya menambahkan bot token gak butuh redeploy.

**Setiap nilai di `config.example.toml` sama dengan default bawaan**, jadi file yang hilang menyalakan
daemon yang sama. Hapus apa pun yang gak kamu ubah. Kunci yang nyaris gak pernah diubah orang gak ada di
file itu maupun di blok-blok di bawah; semuanya didaftar sekali, di [Setelan lanjutan](#setelan-lanjutan).

```bash
nouride config check [file]       # apakah konfigurasi ini akan start? Tidak ada yang dijalankan
nouride config schema [bagian]    # setiap kunci yang valid, sebagai JSON Schema
nouride config explain <path>     # mis. security.web.search_endpoint
```

Salinan beranotasi ikut di sebelah binary sebagai `config.example.toml`, lengkap dengan alasan di balik
tiap kunci di dalamnya; halaman ini petanya.

---

## `[daemon]`

```toml
name = "nouride"
log_level = "info"                  # debug | info | warn | error
data_dir = "./.nouride/data"
agents_dir = "./.nouride/agents"
workspace_dir = "./.nouride/workspace"
timezone = "UTC"
backup_keep = 4
# backup_dir = "/mnt/usb/nouride"
# backup_seal = "nrseal1:…"         # ditulis oleh `nouride secret seal`, bukan tangan
# orchestrator = "nouva"
```

Tiga path, bukan satu root, karena ketiganya memuat jenis hal yang berbeda: state daemon, identitas yang
layak di-commit, dan keluaran yang bisa membesar. `workspace_dir` di disk lain adalah pengaturan yang
didukung.

`backup_keep` adalah berapa snapshot yang disimpan untuk masing-masing dari lima hal, diambil saat boot
lalu tiap minggu: persona pack (`data/backups/agents/`), database (`data/backups/db/`), vault memori
(`data/backups/memory/`) dan, sejak 0.8.18, `config.toml` beserta orang-orangnya dan pustaka MCP
(`data/backups/config/`) serta pool skill (`data/backups/skills/`). Masing-masing melewatkan snapshot boot-nya selama
yang terbaru umurnya belum seminggu. Semuanya ada di disk yang sama dengan yang dilindunginya, kecuali `backup_dir` menyebut
disk lain: sebuah direktori di disk itu, yang gak pernah dibuat, jadi flashdisk USB yang dicabut
berarti snapshot dilewati dan dicatat di log, bukan ditulis ke kartu di bawah mount point yang kosong.
Snapshot yang diambil tepat sebelum migrasi atau tidy vault tetap di `data/backups/`.

`backup_seal` (0.8.18) memasukkan penyimpanan secret ke snapshot config, disegel dengan sebuah passphrase.
`nouride secret seal --stdin`, atau password backup di halaman Secrets dashboard, yang menyetelnya: barisnya berisi salt
dan separuh publik dari kunci yang diturunkan dari passphrase itu, bukan passphrase-nya, jadi daemon menyegel
`secrets.sealed` di tiap snapshot, dan sejak 0.8.19 juga salinan di sebelah penyimpanan di tiap perubahan, dan gak bisa
membuka satu pun. Cuma passphrase itu yang membukanya, lewat `nouride secret unseal`, atau `nouride secret restore`
untuk mengembalikan secret-nya. Tanpanya gak ada snapshot yang memuat secret, dan box yang dibangun ulang dari snapshot
perlu semua kredensial disetel lagi. Nilai yang bukan tulisan perintah itu ditolak saat dimuat.

`orchestrator` (`default_agent` sebelum 0.7.18, ditolak sejak 0.8.0) menjawab ketika
sebuah pesan gak menyebut siapa pun, tiba di gateway tanpa pemilik, dan gak cocok dengan channel binding mana pun. Ia
juga meja depan untuk room yang diisi beberapa bot kita sekaligus: pesan di sana yang gak men-tag, menyebut nama, atau
membalas siapa pun (yang salinannya diterima tiap bot) dijawab olehnya saja, sekali, lewat bot-nya sendiri, kecuali
room itu mewajibkan mention (`groups_require_mention`, atau `/mention on` di grup itu). Pesan yang menyapa seseorang
tetap diarahkan seperti biasa, dan DM gak terpengaruh. Agent pertama yang kamu buat otomatis jadi orchestrator.

## `[agents]`

```toml
mentions_enabled = true
nudge_after_minutes = 5
groups_require_mention = false
group_context_messages = 20
```

[Apa arti masing-masing dalam praktik →](/id/docs/manual/chatting/)

## `[providers.<nama>]`

```toml
[providers.nougate-anthropic]
kind = "anthropic"                  # wire format-nya, bukan vendornya
base_url = "https://nougate.nouverse.tech/anthropic/v1"
api_key = "nougate"                 # NAMA sebuah secret
# headers = { "HTTP-Referer" = "https://nouverse.tech" }
```

Gak ada profil secara default. Setup wizard, dashboard, atau file ini yang membuat profil pertama,
dan `[llm.defaults] provider` tetap kosong sampai saat itu. [Profil provider →](/id/docs/providers/configuration/)

## `[gateways.<platform>.<nama>]`

```toml
[gateways.telegram.nouva]
enabled = true
token = "telegram-nouva"            # NAMA sebuah secret
agent = "nouva"
mode = "polling"                    # atau gak usah ditulis; "webhook" ditolak
# groups_require_mention = true     # setelan [agents] khusus koneksi ini
# group_context_messages = 20       # sama

[gateways.discord.main]
enabled = true
token = "discord-main"

[gateways.discord.main.cache]
messages = 0                        # per channel
users = 0                           # global
members = 0                         # per guild

[gateways.whatsapp.main]
enabled = false
encryption_key = "wa-encryption-key"
# session_dir = "..."               # opsional; kosong: <data_dir>/whatsapp
```

Gak ada yang didefinisikan secara default, jadi instalasi baru menyalakan dashboard dan gak lebih,
alih-alih terus mencoba menyambung ke platform yang token-nya gak ada. [Gateway →](/id/docs/gateways/overview/)

## `[security]`

```toml
approvals = "balanced"                 # careful | balanced | trusted
# model_guard = "off"                 # second look: kosong ikut level; "off" | tier | id model
tool_timeout_ms = 30000
approval_timeout_ms = 300000        # permintaan tak terjawab kedaluwarsa sebagai PENOLAKAN
max_conversation_turns = 200
job_max_ms = 0                      # hentikan background job yang masih jalan setelah ini; 0 = gak pernah
```

`job_max_ms` dihitung dari mulainya job, dan service (`service: true`) dikecualikan. Agent yang
memutuskan mana yang service, jadi ini menghentikan job yang kebablasan, bukan batas keamanan. Paling
besar 2147483647 (sekitar 24 hari).

## `[security.access]`

```toml
mode = "pair"                       # pair | allowlist | open
allowlist = []
```

:::caution
Daemon **menolak start** ketika sebuah gateway chat aktif, seorang agent memegang `exec` dan `mode`-nya
`"open"`, apa pun isi `allowlist`, karena `open` meloloskan semua orang sebelum daftar itu dibaca.
Kombinasi itu adalah remote shell bagi siapa pun yang menemukan bot-nya. `pair`, default-nya, sudah cukup
untuk menghindarinya.
:::

`[security] sender_allowlist`, nama lama allowlist ini, ditolak sejak 0.8.0 sambil menyebut `allowlist`.

[Siapa yang boleh bicara →](/id/docs/manual/access/)

## `[security.exec]`

```toml
landlock = "auto"                   # auto | require | off: Landlock di atas user milik tiap agen, bila kernel punya
blocked = []                        # veto kamu sendiri: ditolak sebelum apa pun, di semua tingkat
max_memory_mb = 0                   # 0 = tanpa batas. Hanya Linux, lewat prlimit; job latar belakang juga
max_cpu_seconds = 0                 # service dikecualikan: server menghabiskannya dengan berjalan
```

Yang bertanya diatur `[security] approvals` (`careful`, `balanced`, atau `trusted`) di atas satu daftar tetap.
`mode`, `ask`, `ask_fallback`, `sensitive_paths`, dan `allowlist` masuk ke situ sejak 0.8.0: file yang masih
menulis salah satunya tetap start dengan peringatan yang menyebut key-nya, dan `mode = "deny"`,
`mode = "allowlist"`, `ask = "always"`, serta `sensitive_paths = "hardline"` ditolak, masing-masing menyebut apa
yang harus ditulis.

[Approval & izin →](/id/docs/manual/approvals/)

## `[security.web]`

```toml
allow_private_urls = false
search_kind = "brave"               # brave | searxng | exa
search_api_key = "brave_search_api_key"
search_endpoint = ""
fallback_enabled = true
fallback_backends = ["duckduckgo"]  # rantai tanpa key, juga dipakai kalau gak ada API key
```

## `[security.rate_limit]`

```toml
messages_per_minute = 10            # per pengirim, per gateway
```

## `[media]`

```toml
image_model = ""                    # kosong = gambarnya dikirim ke model agent itu sendiri, sebagai gambar; atau tingkat: "small"
read_images = true                  # dikirim di chat, dibuka dengan `read`, atau dikembalikan server MCP
read_audio = true
audio_input = "auto"                # auto | always
max_audio_seconds = 600
transcribe_provider = ""            # profil yang punya /audio/transcriptions; kosong = tanpa transkripsi
transcribe_model = "whisper-1"
```

**Gambar yang dilampirkan ke sebuah pesan dikirim ke model agent sebagai gambar.** Bukan deskripsi
tentang gambar itu, piksel aslinya, jadi agent benar-benar melihat layout, warna, dan di mana dua
elemen bertumpuk. Ini gak menambah biaya: gak ada panggilan model kedua, gak ada round trip,
dan transkripnya menyimpan penunjuk ke file-nya, bukan gambarnya, sehingga screenshot minggu lalu
gak ikut diunggah ulang di setiap giliran.

Mengisi `image_model` mematikan itu dan mengembalikan perilaku lama: gambarnya dikirim ke model
*itu*, yang menjawab dalam teks, lalu teks itulah yang diterima agent. Ada dua alasan bagus untuk
memilihnya, model percakapannya memang gak bisa melihat, atau bisa tapi lebih baik yang lebih
murah yang melihat.

:::caution[Deskripsi gak punya koordinat]
Itu pertukarannya, dan layak diketahui sebelum memilih. "Error-nya bunyi apa?" masih selamat kalau
diubah jadi prosa. "Kenapa dua elemen ini bertumpuk?" gak, jawabannya ada di posisi dan ukuran,
dan justru itu yang hilang dari prosanya.
:::

**Voice note dikirim ke model sebagai suara**, tapi hanya ke model yang diketahui bisa mendengar.
`auto` percaya pada daftar model dari gateway (Nougate bilang model mana yang bisa mendengar); `always`
menjamin provider yang bisa mendengar tapi gak bilang begitu, dan mengirim mp3, yang butuh ffmpeg di
mesin ini. Untuk model yang gak bisa mendengar, `transcribe_provider` mengubah klipnya jadi teks dulu:
OpenAI, Groq, atau server Whisper milikmu sendiri. Kalau kosong, agent bilang dia gak bisa mendengarnya.

Dokumen **gak** dikirim ke model sama sekali. Ia mendarat di workspace agent dan agent membukanya
dengan `read` atau sebuah perintah, jadi sebuah PDF gak berbiaya apa pun sampai agent melihatnya.

## `[alerts]`

```toml
gateway = ""                        # mis. "telegram:nouva"
chat_id = ""
```

Tempat daemon melaporkan tentang *dirinya sendiri*, gateway yang menyerah reconnect, sesi yang perlu
ditautkan ulang. Boot, `nouride doctor` dan `nouride config check` memperingatkan selama ini kosong.

## `[dashboard]`

```toml
[dashboard]
enabled = true
host = "127.0.0.1"                  # $HOST menimpanya. Image container menyetelnya ke 0.0.0.0
port = @@PORT@@                     # $PORT menimpanya
public_url = ""                     # dikosongkan, bukan ditebak. Link di chat dibangun darinya
password_login = true               # boleh mati hanya kalau [dashboard.oauth] dikonfigurasi

# [dashboard.oauth]                 # login Nouverse. Hanya dibaca edisi Pro
# issuer = ""
# client_id = ""
# secret_name = ""
# label = "Nouverse"
```

## `[llm.defaults]`, `[llm.limits]`, `[llm.context]`

```toml
[llm.defaults]
provider = ""
model = ""                          # tingkat default
# small_model = ""                  # tingkat small; kosong berarti `model`
# high_model = ""                   # tingkat high; kosong berarti `model`
max_tokens = 0                      # 0 = sesuai model: 32000 untuk Claude 4/5, Gemini 2.5/3, GPT-5; selain itu 8192
temperature = 0.7
# fallbacks = []                   # siapa yang menjawab kalau model agent tidak bisa: [{ provider, model }], berurutan

[llm.limits]
max_tokens_per_turn = 32000
max_tool_iterations = 250
max_turn_duration_ms = 3600000
max_daily_cost_usd = 0              # 0 = mati
max_daily_tokens = 0                # 0 = mati. Berlaku untuk semua model, ada harganya atau gak
cost_alert_threshold_pct = 80

[llm.context]
# compact_at_tokens = 160000        # kosong: angka milik tiap model, 200k di Gemini Flash, 160k sisanya
# summary_model = "small"           # model, atau nama tingkat; kosong: [memory] pass_model, kalau gak ada model agent sendiri
```

[Apa fungsi masing-masing, dan alasannya →](/id/docs/providers/configuration/)

### Tiga tingkat model

`model` itu default untuk semuanya. Di sebelahnya, `small_model` dan `high_model` menyebut model yang lebih murah dan
yang lebih kuat; dua-duanya opsional, dan kalau kosong ya sama dengan `model`, jadi instalasi yang gak pernah
menulisnya jalan persis seperti sebelumnya.

Agent memilih tingkat untuk kerjaan yang dia oper: `delegate` dan `ask_agent` menerima `tier = "small" | "default" |
"high"`, dan kalau gak disebut berarti `default`. Prompt-nya menyebut ketiganya, buat apa masing-masing, dan
perbandingan biayanya (pakai kata-kata, gak pernah pakai angka uang, karena Nouride memang gak tahu harganya), plus
model mana saja di agent itu. Helper jalan di model milik agent yang meminta untuk tingkat itu; agent yang ditanya
lewat `ask_agent` menjawab pakai modelnya sendiri.

Sebuah pack bisa menyebut pasangan miliknya sendiri di `[llm]`. Kalau gak, ia mewarisi milik instalasi selama ia
jalan di `provider` instalasi (id model gak ada artinya di endpoint lain), dan selain itu semua tingkatnya ya
`model`-nya. Dashboard menampilkan ketiga tingkat sebuah agent di tab Model-nya, dan milik instalasi beserta tingkat
tiap helper di halaman Models, lewat tombol **Model tiers**.

Tiap kunci helper juga menerima nama tingkat: `summary_model`, `[memory] pass_model`, `[media] image_model`,
`[skills.learning] model`, dan `[queue] steer_reply_model`. `summary_model = "small"` berarti model small milik tiap
agent, di provider-nya sendiri; `pass_model = "small"` berdiri tanpa `pass_provider`, yang malah ditolak kalau
disandingkan dengan tingkat. Helper tetap pakai model agent sendiri sampai ada yang menulisnya: memindahkannya ke
model murah cukup satu kata per kunci, dan gak ada yang pindah sendiri.

## `[queue]`

```toml
max_concurrent_turns = 8            # untuk semua percakapan. 0 mencabut plafonnya
steer = true                        # pesan di tengah giliran dibaca di langkah berikutnya (room: dari yang memulainya)
```

## `[attachments]` dan `[retention]`

```toml
[attachments]
max_size_mb = 50                    # dihitung saat file tiba; tiap file punya 30 detik untuk diunduh

[retention]
session_days = 30                   # percakapan, file yang menjadi bagiannya, dan misi yang sudah berakhir
audit_days = 30
job_log_days = 3
tool_output_days = 2
log_days = 3                        # log daemon sendiri seperti yang ditampilkan dashboard
scratchpad_days = 3
```

Berapa lama sebuah file disimpan **gak** ada di `[attachments]`. Itu `session_days`, jendela yang sama
dengan transkrip yang menyebutnya, sebuah file adalah bagian dari apa yang dikatakan. Dulu ia punya
kunci sendiri, tujuh hari melawan transkrip tiga puluh hari, dan hasilnya adalah percakapan yang
menyebut sebuah screenshot selama dua puluh tiga hari setelah screenshot-nya dihapus.

`0` pada salah satunya berarti menyimpan semuanya: posisi mati, bukan "hapus semua".

## `[memory]` dan `[rollover]`

```toml
[memory]
dir = "./.nouride/memory"
pass = false                        # dinyalakan di langkah terakhir setup wizard
pass_at = "01:00"
pass_per_night = 20                 # per agent; percakapan langsung dulu
pass_provider = ""                  # kosong: milik tiap agent
pass_model = ""                     # model di pass_provider, atau nama tingkat dengan pass_provider kosong
max_attempts = 3
facts = "off"                       # auto | ask | off; `facts` di [[people]] menang
propose_shared = false              # izinkan pass mengusulkan isi shared.md, tiap usulan menunggu kamu
prompt_recent = 3
recall = true                        # yang diingat masuk ke tiap prompt; recall milik entri [[people]] menang
transcript_days = 180                # 0 menyimpan semua transkrip selamanya
archive = true

[memory.semantic]
enabled = false
provider = ""
model = ""
dimensions = 512

[mcp_server]                        # Nouride sebagai server MCP di /mcp
enabled = false

[rollover]
mode = "none"                       # none | daily | idle
at_hour = 4
idle_minutes = 360
```

`[rollover]` menggantikan `[session_memory]` dari 0.5, yang ditolak sejak 0.8.0 sambil menyebut `[rollover]`.
[Upgrade dari versi yang lebih lama →](/id/docs/deployment/updating/#dari-versi-yang-lebih-lama)

[Untuk apa ini →](/id/docs/architecture/storage/#memori)

## Orang: `people/<key>.toml`

Sejak 0.8.18 setiap orang punya berkas sendiri di samping `config.toml`, `people/alex.toml`, nama berkasnya
jadi key-nya (sekali set; profil memorinya `people/<key>.md` di vault, folder yang berbeda):

```toml
[person]
name  = "Alex"
ids   = ["telegram:5550001111", "discord:214777"]  # akunnya, opsional; angka polos ditolak
notes = "Lebih suka jawaban singkat."
facts = "auto"                             # menimpa [memory] facts untuk orang ini
recall = false                             # menimpa [memory] recall: tidak ada yang tentang dia di prompt
morning = "07:00"                          # morning line-nya, di [daemon] timezone; kosong: tidak ada
morning_to = "telegram:5550001111"         # tujuannya, salah satu ids-nya; kosong: akun tempat ia terakhir menulis
```

Gak ada secara default. Key berisi huruf kecil dan angka, kata-katanya disambung `-`. Akun ditulis
`platform:akun`, bot mana pun yang ia hubungi, dan akun yang ditulis bersama koneksi tempat ia masuk
(`telegram:nouva:814` itu `telegram:814`) ditolak. `morning` adalah jam, `HH:MM`, dan `morning_to` salah satu
`ids` telegram, discord atau whatsapp-nya. Berkas yang gak bisa dimuat (bukan TOML, akunnya sudah dipegang
berkas orang lain, jam yang salah) disebut di log dan orang itu ditinggalkan; daemon tetap jalan. Halaman People,
CLI dan agent menulis berkas ini, masing-masing menyimpan versi terakhirnya sebagai `<key>.toml.bak.N`, dan
berkas yang diedit tangan adalah yang ditambal tulisan berikutnya. [Morning line →](/id/docs/manual/schedule/#morning-line)

Sampai 0.8.17 mereka adalah entri `[[people]]` di `config.toml`. Start pertama 0.8.18 menulis masing-masing ke
berkasnya dan menyimpan bloknya, ditandai sudah dipindah, untuk jalan kembali: 0.8.17 membacanya, dan 0.8.18
tidak selama `people/` ada. Apa yang diubah 0.8.17 di blok itu setelah rollback ikut terbawa: start berikutnya dari
0.8.18 melihat bloknya bukan lagi yang dipindahkannya, lalu memindahkannya lagi, dan tiap berkas yang diganti disimpan
di sebelahnya sebagai `<key>.toml.bak.1`.
[Akses & orang →](/id/docs/manual/access/)

## `[cron]` dan `[jobs]`

```toml
[cron]
enabled = true
unattended_approval = "auto"        # auto | deny

[jobs]
quiet_after_minutes = 5             # 0 = gak pernah memberi tahu
```

`quiet_after_minutes` untuk background job: job yang gak mencetak apa-apa selama itu membangunkan
agent-nya untuk bilang job itu masih jalan, lalu lagi setelah dua kali lipat waktunya, dan dua kali
lipat lagi. Gak ada yang dihentikan karena diam (yang menghentikan job yang jalan terlalu lama itu
`[security] job_max_ms`), dan sebuah agent bisa punya angkanya sendiri di `[jobs]` miliknya.
[Tugas terjadwal →](/id/docs/manual/schedule/)

## `[missions]`

```toml
[missions]
per_agent = 1                       # yang bekerja bersamaan untuk satu agent; yang sedang dicek tidak dihitung
# max_running = 3                   # yang jalan bersamaan di box ini; kosong: setengah jumlah agent, 1 sampai 8
limit_hours = 8                     # jam kerja; waktu menunggu kamu gak dihitung
limit_turns = 100                   # tiap giliran sampai [llm.limits] max_tool_iterations langkah
limit_tokens = 100000000            # input dan output, termasuk milik pemeriksa
```

Misi mengambil batasnya saat dimulai; kalau satu batas tercapai, ia bertanya mau lanjut atau berhenti. Misi yang
menunggu kamu gak memakai slot. Kalau `max_running` gak diisi, nilainya ikut agent yang aktif (setengahnya, dibulatkan
ke bawah, minimal 1 dan maksimal 8), dan bisa diisi sampai sebanyak semua agent. Bisa diatur dari pengaturan di
dashboard juga. [Misi →](/id/docs/manual/missions/)

## `[[external_clis]]`

CLI coding yang kamu tambahkan untuk [agent eksternal](/id/docs/manual/external-agents/), di samping dua yang bawaan,
`claude-code` dan `codex`. Satu tabel per CLI:

```toml
[[external_clis]]
id = "opencode"                     # yang disebut [external] cli di pack: huruf kecil, angka, dan "-", maks 32
name = "OpenCode"                   # ditampilkan di sampingnya; kalau gak ada: id-nya
command = "opencode"                # program yang bicara ACP, di PATH daemon atau lewat path
args = ["acp"]                      # yang menyalakan mode ACP-nya
install = "npm i -g opencode-ai"    # ditampilkan kalau belum ter-install
version_args = ["--version"]        # yang mencetak versinya (default)
profile_env = "OPENCODE_HOME"       # variabel yang menunjuk folder profil; kalau gak ada: profilnya adalah HOME-nya
instruction_file = "AGENTS.md"      # file yang dibacanya tentang dirinya di tempat ia kerja (default)
login = ["auth", "login"]           # dijalankan di terminal di box untuk login; kalau gak ada: gak bisa login dari Nouride
# login_note = "…"                  # ditampilkan di samping login
status = ["auth", "status"]         # keluar 0 kalau sudah login; kalau gak ada: dilihat dari sesi yang dibuka
# signed_out = ["…"]                # kata-kata di penolakan yang berarti belum login
modes = { folder = "build", all = "plan" }   # tiap preset sebagai id mode CLI itu; yang gak ditulis: default-nya
```

Id yang sama dengan CLI bawaan ditolak saat dimuat, begitu juga id yang ditulis dua kali; key yang gak dibaca
diperingatkan. Gak ada `env`: secret yang dibutuhkan CLI diikat ke perintahnya di `[security.exec_secrets]` milik agent.
CLI tambahan jalan sebagai user milik agent hanya kalau tiap agent punya user sendiri, gak dapat skill, dan login sekali
per agent.

Per agent, di `config.toml` pack-nya:

```toml
[external]
cli = "claude-code"                 # wajib: claude-code, codex, atau id [[external_clis]]
profile = "default"                 # akunnya: huruf kecil, angka, dan "-", maks 24 (default)
permissions = "risky"               # folder | risky | all; kalau gak ada: folder kalau agent punya user sendiri, risky di tempat lain
model = "sonnet"                    # sesuai nama dari CLI-nya; kalau gak ada: default CLI
```

`folder` adalah *Free in its folder*, `risky` *Ask when risky*, dan `all` *Ask for everything*. Kalau agent gak punya
user sendiri (Docker, macOS, tanpa helper), `folder` nanya seperti `risky`. `[look]` di file yang sama adalah kucing
agent itu di [Office](/id/docs/manual/office/#tampilan-tiap-agent).

## `[skills]` dan `[skills.learning]`

```toml
[skills]
off = []                            # nama yang gak dimuat siapa pun, apa pun isi skills.toml mereka

[skills.learning]
mode = "ask"                        # off | ask | auto
model = ""                          # kosong: model milik agent itu sendiri; atau nama tingkat
notify_chat = true                  # umumkan draft baru di chat asalnya
```

`mode` menentukan seberapa banyak yang dikerjakan skill learning tanpa kamu: `off` gak memeriksa apa
pun, `ask` menyusun draft skill lalu menunggu, `auto` menyetujui draft-nya sendiri dan memberi tahu
kamu sesudahnya. Usulan dari tinjauan mingguan menunggu manusia di mode apa pun. Nilai yang gak dikenali
dibaca sebagai `ask`, gak pernah sebagai `auto`: nilai yang salah seharusnya berbiaya satu approval,
bukan memberi otonomi. Kapan pass-nya menengok, dan seberapa sering, ditentukan daemon sendiri, bukan
pengaturan.

`[skills.learning]` bernama `[rsi]` sebelum 0.7.27, dengan `require_approval` untuk `ask` dan
`always_allow` untuk `auto`. Tabel `[rsi]` ditolak sejak 0.8.0 sambil menyebut `[skills.learning]`.
[Skill & pembelajaran →](/id/docs/manual/skills/)

## `[nougate]`

```toml
in_process = false                  # diatur dari halaman LLM Gateway di dashboard
```

Setiap build resmi membawa gateway ini, mati secara bawaan. Memilih **Use Nougate** di setup atau **Turn on Nougate** di
halaman LLM Gateway menulis `true` dan menyalakannya tanpa restart; **Turn off** menulis `false` lalu me-restart
Nouride. Start pertama instalasi Router di Community menulis `true` kalau file-nya belum punya `in_process` dan
gateway-nya punya data, jadi ia tetap menyala. Di build tanpa gateway (dikompilasi dari source publik saja),
menyalakannya membuat daemon gak mau start, dengan pesan bahwa build itu gak membawa gateway-nya.
`$NOUGATE_IN_PROCESS` menimpanya.
[Nougate →](/id/docs/providers/nougate/)

---

## Variabel lingkungan

Hanya ini yang menimpa file config. Selebihnya yang struktural adalah urusan `config.toml`.

| | menimpa |
|---|---|
| `HOST` | `[dashboard] host`. **Wajib `0.0.0.0` di dalam container** |
| `PORT` | `[dashboard] port` |
| `LOG_LEVEL` | `[daemon] log_level` |
| `TZ` | `[daemon] timezone` |
| `NOURIDE_DATA_DIR` | `[daemon] data_dir` |
| `NOURIDE_AGENTS_DIR` | `[daemon] agents_dir` |
| `NOURIDE_PUBLIC_URL` | `[dashboard] public_url` |
| `NOURIDE_PASSWORD_LOGIN` | `[dashboard] password_login` |
| `NOURIDE_OAUTH_ISSUER`, `_CLIENT_ID`, `_SECRET_NAME`, `_LABEL` | `[dashboard.oauth]`. Hanya edisi Pro |
| `NOUGATE_IN_PROCESS` | `[nougate] in_process` |

`NOURIDE_CONFIG` menunjuk file-nya langsung dan `NOURIDE_HOME` instalasi tempat file itu berada.
Sisanya, dari akun admin pertama sampai apa yang diset daemon untuk perintah yang dijalankan agent, ada
di [Environment variable](/id/docs/reference/environment/).

Selebihnya di `.env` adalah **kredensial**, dinamai oleh config kamu sendiri:

```bash
# [providers.nougate-anthropic] api_key = "nougate"  →
NOUGATE=

# [gateways.telegram.nouva] token = "telegram-nouva" →
TELEGRAM_NOUVA=

# 64 karakter heksadesimal: openssl rand -hex 32
WA_ENCRYPTION_KEY=

# [security.web] search_api_key = "brave_search_api_key". Tanpa ini, web_search kembali ke rantai
# DuckDuckGo yang gak butuh key.
BRAVE_SEARCH_API_KEY=

# Atau Exa: [security.web] search_kind = "exa", search_api_key = "exa_api_key". Exa gak punya
# fallback tanpa key: tanpa key-nya, web_search gak ditawarkan.
EXA_API_KEY=
```

Gak ada daftar tetap. Setiap variabel ada karena sesuatu di `config.toml` kamu menyebutnya, hapus
yang gak dirujuk config kamu.

Kalau sebuah nama terlalu umum untuk lingkungan kamu, `NOURIDE_SECRET_<NAMA>` juga dibaca.

## Config per agent

`.nouride/agents/<id>/config.toml` dan `skills.toml`.
[Agent & persona pack →](/id/docs/architecture/agents/#configtoml)

## Setelan lanjutan

Jarang dibutuhkan, jadi disingkirkan dari jalan: kunci-kunci ini gak ada di `config.example.toml`, dan satu-satunya
yang punya kontrol di dashboard ditaruh di balik **Advanced**. Masing-masing tetap bekerja persis seperti dulu kalau
ditulis di `config.toml`, dan `nouride config explain <kunci>` menjelaskannya lengkap.

| Kunci | Default | Fungsinya |
|---|---|---|
| `[daemon] shutdown_timeout_ms` | `30000` | Berapa lama stop yang rapi menunggu giliran yang masih jalan. |
| `[daemon] log_pretty` | `false` | Baris log yang enak dibaca manusia, bukan satu objek JSON per baris. Buat development. |
| `[agents] mention_max_hops` | `5` | Berapa kali agent saling oper lewat @mention sebelum rantainya berhenti; manusia yang bicara mereset hitungannya. Ada juga di Agent Settings dashboard, di bawah Advanced. |
| `[agents] job_wake_max_chain` | `100` | Berapa kali background job yang selesai boleh membangunkan agent-nya tanpa ada orang yang bicara. `0` mencabut plafonnya. |
| `[security] tool_max_output_bytes` | `104857600` | Batas output satu perintah yang disimpan di disk (100 MB). Model tetap cuma melihat cuplikannya. |
| `[security] credentials_dir` | `""` | Tempat kredensial berbentuk file; kosong berarti `<data_dir>/credentials`, dibuat `0700`. Gak ada tool file yang bisa menjangkaunya, hanya perintah lewat `$NOURIDE_CREDENTIALS_DIR`, dan daemon menolak start kalau ia jatuh di dalam root yang bisa dibaca. |
| `[security.access] code_ttl_ms` | `900000` | Berapa lama kode pairing bisa dipakai. |
| `[security.access] notify_cooldown_ms` | `300000` | Jeda antar balasan "aku gak kenal kamu" ke pengirim yang sama. |
| `[security.access] deny_cooldown_ms` | `86400000` | Berapa lama pengirim yang ditolak diabaikan sebelum pesannya jadi permintaan baru. Block menahan seseorang sampai di-unblock. |
| `[security.rate_limit] cooldown_reply` | `"Please slow down."` | Yang dibilang ke pengirim yang lewat batas. |
| `[alerts] cooldown_ms` | `300000` | Jeda sebelum alert yang sama diulang. |
| `[media] max_image_bytes` | `8388608` | Gambar yang lebih besar dari ini dilaporkan, bukan dilihat. |
| `[media] max_audio_bytes` | `20971520` | Klip yang lebih besar dari ini, setelah di-transcode, dilaporkan, bukan dikirim. |
| `[control] enabled` | `true` | Sajikan control API ber-token yang dipakai CLI. |
| `[control] chat` | `true` | Daftarkan gateway in-process yang dipakai `nouride chat`. |
| `[llm.streaming] enabled` | `true` | Balasan provider di-stream, bukan ditunggu utuh. |
| `[llm.streaming] typing_indicator` | `true` | Tampilkan indikator "mengetik" platform selama giliran jalan. |
| `[llm.streaming] progress_in_chat` | `true` | Satu baris hidup di chat yang menyebut tool yang sedang jalan, dan kalimat pembuka agent langsung dikirim. |
| `[llm.context] max_context_ratio` | `0.8` | Porsi jendela model yang boleh diisi percakapan. |
| `[llm.context] truncation_strategy` | `"summary"` | `summary` memadatkan giliran lama jadi ringkasan yang disimpan; `sliding_window` membuangnya. |
| `[llm.context] preserve_recent_turns` | `4` | Giliran yang gak pernah dibuang, seketat apa pun budget-nya. |
| `[llm.context] compact_at_ratio` | `0.8` | Porsi budget tempat ruang mulai dibuat. Kenop sehari-harinya `compact_at_tokens`. |
| `[llm.context] preserve_recent_tool_results` | `3` | Hasil tool terbaru yang disimpan utuh waktu ruang dibuat di tengah giliran. |
| `[queue] max_concurrent_per_agent` | `1` | Giliran sekaligus dalam satu percakapan. Harus 1; loader menolak lebih. |
| `[queue] max_queue_depth` | `20` | Pesan yang boleh antre per percakapan sebelum yang tertua dibuang. |
| `[queue] queue_timeout_ms` | `3600000` | Berapa lama sebuah pesan boleh menunggu. Disamakan dengan `max_turn_duration_ms`; loader memperingatkan kalau lebih pendek. |
| `[queue] steer_reply` | `true` | Di bawah "Got it" pesan yang menyetir, satu kalimat dari agent dengan kata-katanya sendiri. |
| `[queue] steer_reply_model` | `""` | Model yang ditanya kalimat itu; kosong berarti model agent sendiri, dan nama tingkat juga boleh. Halaman Models menampilkannya bersama helper lain. |
| `[queue] steer_reply_timeout_ms` | `15000` | Lewat dari ini, "Got it" saja yang dikirim. |
| `[cron] min_interval_ms` | `60000` | Ulangan terpendek yang boleh diminta sebuah job. |
| `[cron] max_jobs` | `100` | Job terjadwal untuk semua agent. |
| `[cron] run_retention_days` | `3` | Hari riwayat run yang disimpan. |
| `[cron] catchup_window_ms` | `3600000` | Seberapa telat job yang kelewat masih boleh jalan setelah daemon mati. |
| `[cron] fail_streak_limit` | `10` | Gagal berturut-turut sebelum job mematikan dirinya sendiri. |
| `[cron] command_timeout_ms` | `600000` | Batas keras perintah terjadwal. |
| `[nougate] port` | `18256` | Port loopback gateway in-process. |

## Nilai tetap sejak 0.8.0

Gak ada yang pernah mengubah ini, jadi sekarang nilainya ditanam di kode. `config.toml` yang masih menulisnya tetap
jalan, dan barisnya disebut di peringatan (`config key is a fixed value since 0.8.0 and ignored`, juga di `nouride config
check`): hapus saja.

| Dulu | Sekarang |
|---|---|
| `[health] heartbeat_interval_ms`, `disk_warn_threshold_mb`, `wal_warn_threshold_mb` | cek disk tiap menit, alert kalau sisa di bawah 1 GB; `/health` degraded kalau WAL lewat 100 MB |
| `[cron] tick_interval_ms` | scheduler tidur paling lama semenit |
| `[queue] dedup_window_ms` | id pesan yang sama dalam satu detik diabaikan |
| tabel `[resilience]` sebuah gateway | ritme reconnect milik tiap platform; WhatsApp lebih pelan dari yang lain |
