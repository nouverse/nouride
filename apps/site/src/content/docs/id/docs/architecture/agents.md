---
title: Agent & persona pack
description: Apa sebenarnya sebuah agent, satu direktori Markdown, dan satu file config di sebelahnya.
---

Sebuah agent adalah **direktori**. Bukan proses, bukan container, bukan baris di tabel.

```
.nouride/agents/nouva/
├── IDENTITY.md      # wajib: nama, headline, emoji, bio
├── SOUL.md          # kepribadian, aturan perilaku, nada bicara
├── AGENTS.md        # agent lain: siapa mereka, bagaimana menghubunginya
├── MEMORY.md        # catatan permanen, agent menulisnya sendiri
├── config.toml      # model, channel binding, tool, workspace
├── mcp.toml         # server MCP milik instalasi yang dipakai agent ini, dan kredensial miliknya sendiri
└── skills.toml      # skill kumpulan mana yang dimatikan untuk agent ini
```

**`IDENTITY.md` satu-satunya file yang wajib.** Selebihnya punya default yang masuk akal, dan agent
dengan identitas saja sudah bisa bekerja.

```bash
mkdir -p .nouride/agents/nouva
printf '# IDENTITY\n- Name: Nouva\n' > .nouride/agents/nouva/IDENTITY.md
```

Pack dimuat ulang tanpa restart: `/reload` di chat, `nouride agent reload <id>`, atau tab Files di
dashboard.

## Untuk apa tiap file

**`IDENTITY.md`**: ini siapa. Nama, headline, emoji, satu baris biografi. Pendek saja.

```markdown
# IDENTITY

- **Name:** Nouva
- **Headline:** Kode dan server: membaca dan mengubah kode, menjalankan perintah dan test
- **Emoji:** 🛠️
- **Bio:** Mengerjakan stack Nouverse. Menjawab dalam bahasa yang dipakai bertanya.
```

Agent lain melihat satu barisnya: **headline**, satu baris pendek, paling banyak 150 karakter, yang bilang untuk urusan
apa agent ini dihubungi. Bagian OTHER AGENTS di prompt mereka, dan daftar yang dipakai `ask_agent` saat sebuah nama
salah, memberi tiap rekan nama tampilannya dan headline-nya (`nouva: Nouva. Kode dan server: …`), atau, di pack yang
belum punya, baris pertamanya yang bukan heading, nama, atau emoji (baris `Role:`, yang ditulis pack sebelum 0.7.18,
bukan headline lagi sejak 0.8.0). Pack yang gak bilang apa-apa cuma dicantumkan dengan nama tampilannya. Jadi headline
itulah yang menentukan apakah agent lain akan meminta bantuan agent ini: tulis untuk apa ia ada, bukan bagaimana ia
bersikap (itu `SOUL.md`).

Headline diisi saat agent dibuat (di onboarding, form New Agent di dashboard, `nouride setup --headline`, atau lewat
`agent_create`), dan kalau dikosongkan, mulai dari headline preset-nya. Daftar Agents menampilkannya, dan tab
**Settings** agent itu mengeditnya; agent lain membaca perubahannya mulai pesan berikutnya.

**`SOUL.md`**: bagaimana ia berperilaku. Nada, aturan tetap, apa yang dilakukan di kasus pinggir. Ini
file yang layak diberi waktu.

```markdown
# SOUL

Kamu Nouva. Jawab singkat dan faktual.

- Bilang terus terang kalau gak tahu.
- Jangan pernah mengarang hasil tool.
- Kalau sebuah permintaan butuh kemampuan yang gak kamu punya, sebutkan yang mana.
```

**Dengan siapa ia bekerja bukan file di sini.** Keluarga, rekan kerja, tiap orang dipanggil apa, dan apa
yang mereka pedulikan ada di **People** (halaman dashboard, atau `[[people]]` di `config.toml`): semua
agent membaca notes seseorang, dan hanya selama orang itu yang sedang bicara. Sampai 0.7.0 tempatnya
`USER.md`, yang dibaca setiap giliran siapa pun yang bicara, sehingga orang kedua di rumah disapa
dengan nama orang pertama. `USER.md` yang masih ada di pack tidak dibaca.

**`AGENTS.md`**: agent lain di daemon ini, dan cara menghubunginya.

Agent gak menyunting `IDENTITY.md`, `SOUL.md`, atau `AGENTS.md` miliknya sendiri: file-file itu memuat aturan dan
batasannya, dan tool file-nya menolaknya (sejak 0.8.8). Ia mengusulkan perubahan lewat tool `persona`-nya, seluruh file
atau satu bagian beserta alasannya, lalu admin melihat diff-nya dan menyetujui atau menolaknya, di semua tingkat
approval, termasuk `trusted`, dan begitu juga untuk agent yang dijawab CLI coding. Diff-nya menaruh tiap baris yang
berubah di bawah tempatnya: heading-nya, label-nya, baris header tabel untuk baris tabel (sejak 0.8.13), dan item list
tempat ia berada. Sejak 0.8.13, baris-baris lanjutan sebuah aturan ditampilkan sekali di bawah baris pertamanya yang
diubah, bukan dikeluarkan lalu dimasukkan lagi satu per satu, jadi aturan yang panjang tetap bisa diubah dalam batas
yang ditunjukkan ke admin sekaligus (24 baris, 2.400 karakter). Kalau disetujui, daemon yang menulisnya, menyimpan versi
sebelumnya sebagai `<file>.bak.1`, mencatatnya di audit log, lalu memuat ulang agent itu. Tab **Files** di dashboard
tetap jadi cara kamu sendiri untuk mengubahnya.

**`MEMORY.md`**: catatan milik agent sendiri (cara kerjanya, apa yang sedang dikerjakannya), ditulis
lewat tool `memory_write`, dalam bahasa Inggris apa pun bahasa chat-nya. Apa yang dipelajarinya
tentang orang masuk ke [vault memori](/id/docs/architecture/memory/), bukan ke sini. **Gak ada yang
bisa membangun ulang file ini.** Ia gak ada di git, dan ia menumpuk. Karena itu daemon menyimpan
salinan bertanggal di `data/backups/agents/`.

## Isolasi terjadi karena konstruksi

Sebuah agent cuma memuat direktorinya sendiri. Apa yang diketahui satu agent tentang agent lain datang
dari `AGENTS.md` miliknya, dari nama-nama yang didaftar prompt-nya, dan dari apa yang dikatakan agent
lain itu kepadanya, gak pernah dari membaca file agent lain.

Gak ada pemeriksaan izin yang membuat itu benar. Itu benar karena gak ada apa pun di pemuatnya yang
melihat ke tempat lain.

## `config.toml`

Apa pun yang dihilangkan jatuh ke default daemon. Id agent adalah nama direktorinya. Kunci yang gak
dibaca pack, entah salah ketik atau sudah dihapus sebuah rilis, disebut di peringatan waktu load
(`unknown pack config key ignored`, juga di `nouride config check`) dan agent-nya tetap jalan, sama
seperti config daemon.

```toml
[agent]
display_name = "Nouva"
emoji = "🛠️"
enabled = true
approvals = "balanced"   # careful | balanced | trusted | per-person (tanpa nilai: ikut setelan tiap orang)
access = "follow"     # follow | pair | allowlist: cara orang asing di koneksinya diperlakukan

# `provider` menyebut sebuah profil [providers.*] di config daemon. Profil itu yang memiliki endpoint,
# wire format dan kredensialnya, jadi memindahkan agent ini ke deployment lain cukup satu kata.
[llm]
provider = "nougate-anthropic"
model = "claude-sonnet-4-20250514"
# small_model = "claude-haiku-4-5"   # tingkat small dan high-nya; kosong: milik instalasi di provider-nya, selain itu `model`
# high_model = "claude-opus-4-1"
max_tokens = 8192
temperature = 0.7
max_tool_iterations = 40   # opsional: anggaran milik agent ini sendiri, menggantikan milik daemon
max_turn_seconds = 900

# Chat tempat agent ini menjawab, dikunci pada id INSTANCE GATEWAY, karena dua bot di satu platform
# adalah dua audiens berbeda. Kosong berarti ia cuma menjawab saat dipanggil namanya, atau selalu,
# kalau sebuah instance gateway menyebutnya sebagai pemilik.
[channels]
"discord:main" = ["1234567890123456789"]
"telegram:nouva" = ["-1001234567"]

# Tanpa `enabled`: membaca file dan web, memori, perencanaan, dan `nouride` lewat approval.
[tools]
enabled = ["read", "web_search", "web_fetch", "memory_read", "memory_write", "person_record", "person_notes", "send_file"]
# atau ["*"]: semua tool, termasuk yang ditambahkan rilis berikutnya (yang ditulis setup untuk agent pertama)
approval_required = ["exec", "write", "edit"]
blocked = ["rm", "shutdown", "reboot"]   # perintah yang langsung ditolak exec

# Helper yang boleh dijalankannya di latar belakang sekaligus (tanpa nilai: [delegate] milik daemon, 2). 0 = mati.
[delegate]
max_background = 1

# Misi yang boleh dikerjakannya bersamaan (tanpa nilai: [missions] per_agent milik daemon, 1). 1 sampai 4.
[missions]
per_agent = 3

# Direktori yang boleh dijangkau tool file dan exec agent ini, di luar pack-nya sendiri dan workspace.
# Kosong berarti cuma itu: aman, tapi ia gak bisa menyentuh proyek apa pun.
[workspace]
roots = ["/home/kamu/projects/thing"]
skill_roots = ["/home/kamu/projects/thing"]

[security]
sender_allowlist = []
ssh_agent = true      # perintah dan server MCP stdio-nya mendapat SSH_AUTH_SOCK daemon (mati kalau gak ditulis)

[security.exec_secrets]  # NAMA secret yang nilainya sampai ke perintah yang diikatnya, sebagai variabel
pypi_token = ["twine upload"]

# CLI coding yang menjawab agent ini, menggantikan model [llm]-nya: agent eksternal.
# [external]
# cli = "claude-code"     # claude-code | codex | id [[external_clis]] dari config.toml daemon
# profile = "default"     # akun yang dipakainya untuk menjawab
# permissions = "risky"   # folder: Free in its folder | risky: Ask when risky | all: Ask for everything
# model = "sonnet"        # sesuai nama dari CLI-nya; kalau gak ada: default CLI

# Kucingnya di Office. Tiap bagian opsional; yang gak ditulis diambil dari id agent.
[look]
fur = "black"
hat = "beanie"
```

`[external]` dibaca saat dimuat: CLI yang gak dikenal install ini, nama profil yang bukan huruf kecil, angka, dan
tanda hubung, atau preset yang bukan salah satu dari tiga, bikin agent itu gagal dimuat, dengan menyebut field-nya.
[Agent eksternal →](/id/docs/manual/external-agents/) Kata di `[look]` yang bukan salah satu kata bagiannya juga sama.
[Office →](/id/docs/manual/office/#tampilan-tiap-agent)

### `roots` dan `skill_roots` sengaja dua daftar berbeda

**Root** adalah tempat agent boleh membaca dan menulis. **Skill root** adalah tempat ia menerima
*instruksi*, dan instruksi itu mendarat di system prompt, posisi paling dipercaya dalam sebuah
permintaan.

Memuat skill otomatis dari semua yang terjangkau akan menjadikan sebuah pull request sebagai vektor
prompt injection. Repositori yang kamu clone kemarin seharusnya bisa jadi yang pertama tanpa jadi yang
kedua.

Skill milik sebuah skill root ada di `.agents/skills/`-nya, dan skill baru di sana langsung dikenali
di pesan berikutnya, tanpa reload. Skill itu read-only bagi agent, dan skill kumpulan atau bawaan
dengan nama sama yang menang. Skill di sana boleh berupa link ke folder lain di dalam root yang sama,
misalnya milik submodule privat, dan dimuat seperti yang lain. Link yang keluar dari root dilewati:
menyebut sebuah root berarti memercayai direktori itu, bukan ke mana pun link-nya mengarah.

Agent tahu soal ini. Saat disuruh mengerjakan proyek yang punya `.agents/skills/` tapi bukan salah
satu skill root-nya, agent membaca skill yang cocok dengan tugasnya sebagai aturan proyek itu, seperti
membaca file `CONTRIBUTING`, lalu bertanya ke kamu apakah proyek itu mau ditambahkan ke `skill_roots`.
Agent gak bisa menambahkannya sendiri: `config.toml`-nya adalah milikmu untuk diubah.

### Skill gak dikonfigurasi di sini

Ada satu kumpulan di `agents/skills/`, dan semua agent mendapat seluruhnya, ditambah skill bawaan
Nouride. Pengecualiannya di `skills.toml` di sebelah pack:

```toml
[skills]
document-authoring = false
```

Menyala secara default, bukan daftar opt-in, karena daftar yang ditulis hari ini gak bisa menyebut
skill yang datang bulan depan. `[skills] off` di config daemon mematikan sebuah skill untuk semua
agent.

Skill bawaan ada di samping binary dan diganti setiap update, jadi gak disunting di tempat: perintah
agent yang menulis ke sana ditolak. Untuk mengubahnya, salin ke kumpulan, dan salinan itu yang menang.
[Skill →](/id/docs/manual/skills/)

### Server MCP

Tool eksternal, dipasang sekali lalu dinyalakan per agent, seperti skill. **Settings → Connectors** di dashboard
adalah daftar server milik instalasi (library-nya, `agents/mcp.toml`), dan tab **Connectors** sebuah agent menyalakan
atau mematikan masing-masing untuk agent itu. Tool sebuah server ditemukan saat terhubung lalu ditawarkan sebagai
`<server>__<tool>`, karena namanya datang dari server dan gak bisa didaftarkan di `[tools] enabled` sebelum kamu pernah
terhubung sekali.

```toml
# agents/mcp.toml: library-nya
[[servers]]
name = "nouva-mcp"
transport = "stdio"
command = "python3"
args = ["/path/to/server.py"]
env = { MEMORY_DIR = "/data/memory" }
env_secrets = { GITHUB_TOKEN = "github_token" }   # variabel = NAMA sebuah secret, bukan nilainya

[[servers]]
name = "browser"
transport = "streamable-http"
url = "https://mcp.example.com/mcp"
auth_secret = "example-mcp-token"      # NAMA sebuah secret, bukan nilainya
headers = { "X-Client" = "nouride" }
```

```toml
# agents/nox/mcp.toml, ditulis oleh dashboard dan `nouride mcp`, satu tabel per server
[servers.browser]
on = true

[servers.nouva-mcp]
on = true
env_secrets = { GITHUB_TOKEN = "nox_github_token" }   # milik nox sendiri, menggantikan punya library
```

Kredensial sebuah server adalah milik library (satu token, satu set variabel, satu login) untuk setiap agent yang
menyalakannya, kecuali agent itu membawa miliknya sendiri: secret-nya sendiri, atau `login = "own"` untuk login sebagai
orang lain. `per_agent = true` pada sebuah server berarti tidak ada yang dibagi: tiap agent membawa miliknya sendiri.
`[[mcp_servers]]` milik sebuah pack di `config.toml`-nya, dari sebelum 0.7.19, ditolak sejak 0.8.0: agent itu gak dimuat,
dan pesannya menyuruh menambahkan server itu ke library (`nouride mcp add` atau halaman Connectors), menyalakannya
untuk agent itu, lalu menghapus blok tersebut.

**Memilih tool-nya.** Semua tool yang ditawarkan sebuah server ikut di setiap request yang dibuat agent: 65 tool milik
Notion itu sekitar 250 KB definisi, terkirim tiap kali. Supaya agent hanya dapat tool yang dipakainya, buka **Tools** di
baris server itu pada tab Connectors milik agent, centang yang dibutuhkan (tiap tool menunjukkan berapa yang
ditambahkannya ke satu request) lalu **Save**, atau dari shell:

```bash
nouride mcp tools notion --agent nox                                   # tool-nya, ukuran masing-masing, mana yang dipunya nox
nouride mcp tools notion --agent nox --only notion-search,notion-fetch
nouride mcp tools notion --agent nox --all                             # semua tool lagi
```

Itu menulis `tools = ["notion-search", "notion-fetch"]` ke tabel server itu di `agents/nox/mcp.toml`. Tanpa baris itu
agent dapat semua tool, seperti sebelumnya.
Tool yang tidak dipilih tidak dikirim ke model, dan panggilan ke tool itu ditolak dengan menyebut pengaturannya. Nama yang
tidak ditawarkan server (misalnya karena diganti namanya) bukan error: tool lain tetap jalan, dan log serta
`nouride doctor` menyebut nama mana yang hilang.

**Mencari server.** Tab **Explore** di halaman Connectors mencari di katalog MCP Nouverse, mirror dari
[registry MCP resmi](https://registry.modelcontextprotocol.io), sekitar empat puluh lima ribu server, yang dijaga tetap
baru dan diurutkan oleh Nouverse. Sebelum kamu mengetik, yang tampil adalah pilihan Nouverse; saat mencari, server milik
penerbitnya sendiri muncul paling atas. Tiap hasil menyebut siapa penerbitnya (namespace yang harus dibuktikan penerbit
ke registry: `com.notion/mcp` milik notion.com), bagaimana ia jalan di sini (endpoint remote, atau paket lewat `npx`,
`uvx`, atau `docker` kalau terpasang), dan apa yang dimintanya; yang tidak bisa jalan di mesin ini menyebut apa yang kurang ("needs uv", "Docker not
usable") dan cara memasangnya. **Add** membuka form biasa yang sudah terisi, versinya
dikunci; yang cuma bisa kamu isi (token, `{slug}` di URL-nya) ditandai, dan form-nya gak bisa disimpan sebelum diisi.
`nouride mcp search [kata]` dan `nouride mcp add --from <nama> [--agent <id>]` melakukan hal yang sama dari shell. Agent
bisa mencari lewat `mcp_search`, dan menjawab dengan link yang membuka Explore di server itu: menambahkannya tetap
keputusanmu.

Tidak ada isi registry yang disimpan di mesinmu: pencarian dikirim ke `service.nouverse.tech/mcp-catalog` (kata-katanya
saja, tidak ada yang lain), dan cara sebuah server akan jalan di sini dihitung di sini. `NOURIDE_MCP_CATALOG_URL`
mengarahkan daemon ke salinan katalog lain, termasuk yang ada di jaringanmu sendiri, atau, kalau dikosongkan, mematikan
Explore, `nouride mcp search`, dan `mcp_search`. Menambah server secara manual tidak pernah membutuhkannya.

Server stdio yang butuh token di environment-nya mendapatkannya lewat `env_secrets`: tiap variabel menyebut nama sebuah
secret, nilainya dibaca dari secret store saat server dijalankan, dan secret yang belum diisi menghentikan start-nya
sambil menyebut variabelnya. Nilai yang kelihatan seperti token-nya sendiri ditolak saat dimuat, begitu juga variabel
yang juga diisi di `env`. Form server menyimpan apa yang kamu ketik di sana dengan nama sendiri (`mcp-lib-<server>-<variabel>`, atau
`mcp-<agent>-<server>-<variabel>` untuk milik agent sendiri); `nouride mcp
add --env-secret GITHUB_TOKEN=github_token` menyebut secret yang kamu isi dengan `nouride secret set <nama> --stdin`.

**Login.** Server jarak jauh yang gak punya kredensial sendiri (tanpa `auth_secret`, tanpa header `Authorization`)
dicoba tanpa kredensial, dan server yang menjawab dengan minta login, seperti punya Notion dan Linear, tampil sebagai
**needs login** di kartunya dan di `nouride mcp`. **Connect** membuka halaman login server itu di tab baru. Setelah kamu
mengizinkan akses, browser kembali ke dashboard (`/dashboard/oauth/mcp/callback` di `[dashboard] public_url`, atau di
loopback mesin ini kalau gak diisi) dan server-nya terhubung. Kalau halaman itu gak bisa dibuka karena browser-nya ada
di mesin lain, tempel alamat terakhir yang dibuka browser ke kartunya. Login-nya milik library, dipakai setiap agent yang gak punya login sendiri, kecuali agent itu punya
`login = "own"`. Dari shell, `nouride mcp login --server <nama>` (dengan `--agent <id>` untuk login milik agent sendiri)
mencetak alamat yang harus dibuka lalu meminta alamat tempat browser berakhir, jadi bisa lewat SSH.
`--client-id` untuk server yang gak mendaftarkan client sendiri, misalnya GitHub; secret client-nya ditanyakan, gak
pernah diketik di command line.

Token akses dan token refresh disimpan di secret store sebagai `mcp-oauth-shared-<server>-access` dan `-refresh` (atau
`mcp-oauth-<agent>-…` untuk milik agent sendiri), jadi setiap hasil ikut disamarkan dari keduanya. Keduanya
diperbarui sendiri, dan tiap pasangan baru disimpan dalam satu tulisan sebelum dipakai. Kalau server berhenti menerima
login-nya (refresh-nya ditolak), server kembali ke needs login, kamu diberi tahu sekali lewat `[alerts]` beserta tempat
untuk login, dan agent yang memanggil tool-nya diberi tahu bahwa seseorang harus login lagi. Server yang cuma gak bisa
dijangkau tetap dianggap gangguan. `nouride mcp logout` menghapus token-nya. Login cuma bisa
dilakukan admin, dan agent yang menjalankan `nouride mcp login` atau `logout` selalu ditanyakan dulu.

Ketiga transport bekerja: `stdio` menjalankan proses di sini; `streamable-http` dan `sse` menghubungi
endpoint jarak jauh (`sse` bentuk lama, pilih streamable-http kecuali server-nya cuma bisa sse).

Nouride bicara MCP 2025-06-18, dan 2025-03-26 atau 2024-11-05 dengan server yang menjawab salah satunya.
Server yang menjawab versi lain ditolak, dan log-nya menyebut server itu dan kedua versinya. Server yang
tool-nya berubah selagi jalan, dan sudah bilang akan memberi tahu, didaftar ulang tool-nya untuk giliran
agent berikutnya: log-nya menyebut apa yang ditambah dan dihapus, dan giliran yang sedang jalan tetap
memakai tool yang ia mulai. Argumen dicek terhadap skema tool sebelum panggilan dikirim, yang wajib dan
tipe tiap argumen, dan panggilan yang gak cocok kembali ke model dengan apa yang harus dibetulkan, bukan
ke server. Hasilnya dicek dengan cara yang sama terhadap skema output tool, kalau tool itu menyatakannya: hasil
yang datanya kurang field wajib, punya field bertipe salah, atau gak ada datanya sama sekali sampai ke model
sebagai error yang menyebut tiap masalahnya, bukan datanya, dan log mencatatnya di level warn dengan nama server
dan tool-nya.

Nama server adalah awalan nama tool-nya, jadi tiap server butuh nama sendiri, dan nama
itu gak boleh memuat `__` atau diakhiri `_`: keduanya bisa memberi tool dua server satu nama yang sama.
Library-nya ditolak saat dimuat, dengan menyebut entri-entrinya, alih-alih menawarkan server mana pun
yang terhubung terakhir. Berapa biaya tool sebuah server di setiap permintaan agent ditampilkan
`nouride mcp` dan tab Connectors agent itu; lewat dari 16KB ia disebut di level warn dan oleh `nouride doctor`.

Tool MCP berjalan **tanpa bertanya**, persis seperti tool bawaan yang gak didaftarkan siapa pun.
Untuk menahannya, sebutkan di `approval_required` dengan nama lengkapnya.

Hasilnya *dan deskripsi tool-nya* ditandai sebagai gak tepercaya sebelum dilihat model: keduanya teks
yang ditulis orang yang bukan kamu. Menandai bukan menahan: server yang perintahnya gak akan kamu
jalankan adalah server yang gak seharusnya kamu hubungkan.

Untuk `stdio`, proses anaknya mendapat environment minimal, `PATH`, `HOME`, locale, `TMPDIR`: bukan
seluruh environment daemon, dan `SSH_AUTH_SOCK` hanya kalau pack-nya bilang `ssh_agent = true`. Berikan
yang lain lewat `env`. Kalau tiap agent jalan sebagai user-nya sendiri, server-nya juga: HOME dan install-nya milik
agent itu, dan dia mulai di folder agent kecuali blok-nya menyebut `cwd`, yaitu folder yang boleh dimasuki user itu. Server
yang dulu menyimpan login atau setelannya di HOME daemon gak menemukannya lagi, karena user agent gak bisa membaca folder
itu: login ulang untuk tiap agent, berikan token-nya lewat `env_secrets` kalau server itu membaca token, atau salin
yang dia simpan ke folder agent itu. Di Docker, macOS, atau tanpa helper, server stdio tetap jalan sebagai user daemon
dan bisa membaca apa yang dibaca daemon: kasih server shell atau file cuma ke agent yang kamu percaya untuk itu.
[Tiap agent punya user sendiri →](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri)

Server terhubung saat boot dan lagi setiap kali pack dimuat ulang. Perubahan dari dashboard atau `nouride mcp` memuat
ulang agent yang terkena, yang menyambungkan atau menutup server-nya. Tidak ada yang restart; file yang diubah manual
berlaku lewat `/reload` atau `nouride agent reload <id>`.

```bash
nouride mcp                                             # library, agent tempat tiap server menyala, dan tool-nya
nouride mcp add --name browser --url https://mcp.example.com/mcp --stdin --agent nouva
nouride mcp enable browser --agent nox                  # nyalakan untuk agent lain
nouride mcp disable browser --agent nox                 # matikan untuknya; library tetap menyimpannya
nouride mcp rm browser                                  # keluarkan dari library dan dari semua agent
nouride mcp login --server notion                       # server jarak jauh yang minta login, untuk semua agent
nouride mcp logout --server notion
```

## Di mana agent bekerja

```
.nouride/workspace/
  shared/           semua agent. Di sinilah path relatif diselesaikan
  private/<id>/     satu agent, dan gak ada agent lain bisa membacanya
```

**`shared/` adalah direktori kerjanya**, dan itulah yang membuat serah terima mungkin. Dua agent dalam
satu channel mendelegasikan dengan tag; dengan workspace per agent, build yang diserahkan berada di luar
setiap direktori yang boleh dibuka agent kedua, jadi sandbox menolaknya bagaimanapun path ditulis. Tag
bisa membawa instruksi tapi gak pernah membawa pekerjaannya, dan gak ada yang melaporkan itu sebagai
kegagalan. Agent kedua cuma menjawab bahwa filenya gak ada.

Dua agent dalam satu grup bisa bekerja bersamaan, jadi penulisan memakai kunci per file: `write`,
`edit` dan `memory_write` ke satu path gak pernah saling selip, dan gak ada yang kehilangan perubahan
yang lain.

`private/<id>/` untuk draft dan coretan. Apa pun yang mungkin perlu diambil agent lain gak layak
ditaruh di sana, dan prompt tiap agent menyebutkan itu.

**Persona pack bukan workspace.** Dulu pekerjaan mendarat di `agents/<id>/`: terlihat pada sebuah run
nyata, dengan proyek operator dibangun di sebelah `IDENTITY.md` di direktori yang dilacak git. Itu
sebabnya keduanya path terpisah, dan sebabnya `workspace_dir` bisa menunjuk disk lain tanpa
memindahkan apa pun.

## Preset, tool dan orchestrator

Agent baru dari dashboard dimulai dari sebuah **preset**, yang menentukan tool pertamanya dan beberapa
baris tentang cara kerjanya di `AGENTS.md`, dan gak disimpan sesudahnya. **New Agent** cuma bisa dipakai admin, dan
di **Answered by** bisa memilih CLI coding yang ada di box sebagai ganti model: sebuah
[agent eksternal](/id/docs/manual/external-agents/). Approval bukan bagian dari
preset: setiap agent baru ditulis dengan `[agent] approvals = "balanced"`, jadi ia cuma bertanya sebelum
hal yang destruktif, menyentuh sistem, infrastruktur atau kredensial, atau membuka session interaktif,
untuk siapa pun yang bicara dengannya.

| Preset | Dimulai dengan |
|---|---|
| **Pilot** | Semua tool. Agent pertama, dari setup wizard, selalu yang ini. |
| **Researcher** | Web search dan fetch, membaca file, memori. Tanpa terminal, gak menulis apa pun. |
| **Assistant** | Memori, pengingat, web search, mengirim file. Tanpa terminal. |
| **Developer** | File, terminal, test, web fetch untuk dokumentasi. |
| **Custom** | Tool yang kamu pilih. |

Setelah itu tool-nya berupa sakelar di tab **Settings** agent tersebut (ditulis ke `[tools] enabled`),
di samping anggaran tool dan gilirannya serta berapa helper yang boleh dijalankannya di latar belakang.
**Make orchestrator** di halaman sebuah agent menetapkan `daemon.orchestrator`: agent yang dituju pesan
ketika gak ada yang menyebut agent lain, meja depan di room yang berisi beberapa bot kamu, dan yang didaftar paling
atas di mana-mana.

## Helper di latar belakang

Agent bisa menyerahkan tugas yang makan waktu ke sebuah **helper** lalu tetap bisa kamu ajak ngobrol:
`delegate` dengan `background: true`. Gilirannya langsung selesai dengan apa yang dimulainya; helper
bekerja sendiri, dan hasilnya kembali ke agent sebagai pesan begitu selesai, lalu agent melaporkannya
dalam bahasamu. Dua helper dilaporkan satu per satu, masing-masing begitu selesai, jadi yang selesai duluan
gak ditahan menunggu yang kedua.

Agent diberi tahu kebiasaannya: satu helper untuk tugas yang lebih lama dari beberapa menit dan kurang
dari sejam (riset lintas file atau host, build panjang, gladi migrasi) supaya ia tetap siaga untukmu; dua
cuma untuk dua bagian yang saling lepas; kerja yang mungkin lewat dari sejam adalah urusan misi. Bukan
untuk jawaban cepat, dan bukan untuk hal yang sedang kamu tunggu sekarang.

- **Yang diserahkan adalah sebuah brief**, dalam bahasa Inggris apa pun bahasamu: tujuannya, konteks
  yang gak mungkin diketahui helper (path, host, apa yang sudah dicoba), batasannya, dan apa yang harus
  dikembalikan. Brief tanpa konteks ditolak, beserta apa yang perlu ditambahkan.
- **Helper mewarisi apa yang boleh dilakukan agent** (tool, grant dan approval-nya, server MCP-nya,
  skill-nya), tapi bukan siapa dirinya: tanpa persona, tanpa memori. Ia gak menulis memori, gak mengirim
  apa pun ke chat, dan gak memulai helper sendiri; ia menyebut apa yang layak disimpan, dan agent yang
  memutuskan.
- **Berapa sekaligus** diatur `[delegate] max_background`: 2 secara default, 0 mematikannya, bisa diatur
  per agent di tab **Settings**-nya, berlaku mulai helper berikutnya.
- **Tiap helper adalah sebuah job**: muncul di `nouride jobs` dan di Work → Helpers di dashboard
  dengan tujuannya, dan di strip chat selama berjalan. `/stop` di chat menghentikan helper agent di
  chat itu; `nouride jobs kill <id>` menghentikan satu.
- **Approval yang dibutuhkannya** ditanyakan di chatmu, dengan nama dan tujuannya: "a background task
  (job_…: …) wants to run this". Kalau gak dijawab, ia berhenti di situ dan bilang begitu.
- **Kalau mesinnya lagi sibuk, ia menunggu sebelum mulai** (0.8.0): saat CPU terpakai lebih dari 70% selama
  semenit terakhir, thermal zone yang melewati trip point-nya, atau cgroup daemon yang kekurangan memori.
  Log-nya mencatat itu. Paling lama sepuluh menit, lalu ia tetap mulai. Helper yang ditunggu agent
  selagi kamu menunggu, dan balasan agent ke kamu, gak pernah menunggu.
- **Restart** menghentikannya. Ia gak dilanjutkan: agent diberi tahu apa yang sudah dikerjakannya, dan
  bisa memulainya lagi.
- **Di misi yang kerja di worktree**, `delegate` dengan `isolated` memberi tiap helper worktree dari worktree misi
  itu, di branch sendiri, `mission/<id>-helper-<n>`, jadi helper yang menulis gak saling menimpa; hasilnya menyebut
  branch-branch itu untuk di-merge oleh misinya. Di luar itu `isolated` ditolak.
  [Misi di dalam repo →](/id/docs/manual/missions/#di-dalam-repo)

## Permintaan yang makan waktu

Saat sebuah agent meminta tolong agent lain lewat `ask_agent` (0.7.19), ia menunggu jawabannya paling lama
semenit, seperti sebelumnya. Kalau agent lain itu masih bekerja setelahnya (deploy, audit), pekerjaannya
lanjut di latar belakang, agent yang sedang kamu ajak bicara bilang begitu, dan kamu tetap bisa ngobrol
dengannya. Begitu jawabannya datang, agent itu dibangunkan di chat yang sama, dengan keterangan itu jawaban
untuk permintaan apa dan kapan dimintanya, jadi tetap nyambung walau kamu sudah pindah topik. Agent yang
tahu pekerjaannya bakal lama meminta dengan `background: true` dan gak menunggu sama sekali.

- **Ia adalah job milik agent yang meminta**, `ask <agent>: <tugas>` di `nouride jobs` dan di Work → Helpers
  di dashboard, dan di strip chat selama berjalan. `/stop` di chat itu dan `nouride jobs kill <id>`
  menghentikannya; `[security] job_max_ms` membatasinya; restart menutupnya sebagai terputus, dan agent
  diberi tahu.
- **Ia berbagi batas dengan helper**, `[delegate] max_background`. Kalau batas itu penuh, permintaannya
  ditunggu sampai selesai seperti dulu, dan disebutkan kenapa lama.
- **Gagal, kena batas waktu, dihentikan, atau restart**: semuanya juga membangunkan agent yang meminta,
  dengan keterangan yang mana.
- **Approval yang dibutuhkan agent lain itu** setelahnya tetap ditanyakan di chatmu, atas namanya, dengan
  keterangan itu pekerjaan siapa.
- Cuma agent yang kamu ajak bicara yang memindahkan permintaan ke latar belakang: permintaan dari helper
  dan dari job terjadwal selalu menunggu jawabannya.

## Pekerjaan yang lama diingatkan, bukan dihentikan

Pada `[agents] nudge_after_minutes` (5) lalu tiap kelipatan dua (10, 20, 40 menit), pekerjaan yang lama
diingatkan soal waktunya. Gak ada yang dimatikan; `llm.limits.max_turn_duration_ms` tetap satu-satunya batas
keras. `0` mematikannya.

- **Helper, atau agent yang dimintai lewat `ask_agent`,** membaca sebelum langkah berikutnya: sudah N menit
  ia mengerjakan ini, dan kalau buntu atau masih bakal lama, ia sebaiknya berhenti dan melapor jujur: apa
  yang sudah, apa yang belum, buntunya di mana, apa yang ia butuhkan.
- **Agent yang menunggunya di latar belakang** diberi tahu di chatmu sudah berapa lama ia berjalan dan bahwa
  ia sudah diminta melapor kalau buntu. Agent itu bisa menunggu, memberitahumu, atau menghentikannya dengan
  `nouride jobs kill <id>`.
- **Balasan yang sedang kamu tunggu** diminta mengirim status satu baris, dan bilang kalau buntu lalu berhenti.

## Menjalankan agent

```bash
nouride agents                       # daftar, dengan statusnya
nouride agent sleep <id>             # gak menerima kerjaan sampai wake, restart pun tidak menghapusnya
nouride agent wake  <id>
nouride agent reload <id>            # baca ulang pack dari disk
nouride agent enable  <id>           # ditulis ke config.toml, jadi bertahan setelah restart
nouride agent disable <id>
nouride agent external <id> <cli> [--profile <nama>]   # CLI coding yang menjawabnya mulai sekarang
nouride agent internal <id>                            # model-nya menjawab lagi
```

Sleep dan wake adalah status runtime. Enable dan disable ditulis ke file config. Bedanya penting pada
jam 2 pagi: menidurkan sesuatu gak sama dengan memutuskan ia gak boleh kembali. `external` dan `internal` menulis
atau menghapus `[external]` di `config.toml`-nya, dan cuma bisa dilakukan admin.

## Blok harness

Agent mengetahui kemampuannya sendiri dari **blok harness** yang dibuat segar ke system prompt-nya
setiap giliran, dari state langsung: tool apa yang dimilikinya, apakah ada manusia yang bisa ditanya
sekarang, sisa anggaran putarannya, dan perintah apa yang bisa diketik orang di chat ini. Agent yang
punya shell juga diberi tahu program apa yang sudah terpasang, berdasarkan namanya, bahwa `HOME`-nya
bertahan, dan perintah instalasi mana yang bisa jalan di host ini.

Itu sebabnya agent tahu untuk gak menjanjikan hal yang gak bisa dilakukannya, dan sebabnya jawabannya
berubah ketika kamu mematikan sebuah tool. `/prompt` di pesan langsung menampilkan keseluruhannya.
