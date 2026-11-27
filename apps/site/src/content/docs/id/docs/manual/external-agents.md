---
title: Agent Eksternal
description: Agent yang dijawab oleh CLI coding (Claude Code, Codex, Antigravity, Cursor CLI, Grok Build, atau yang kamu tambahkan sendiri), dengan channel, misi, dan approval dari Nouride; plus agent Nouride di editor kamu.
---

**Agent eksternal** adalah agent Nouride yang giliran kerjanya dijawab oleh CLI coding. Kamu ngobrol dengannya seperti
agent lain (lewat bot Telegram atau Discord-nya, di room, di dashboard, di misi), dan CLI-nya yang mengerjakan, pakai
model dan login-nya sendiri. Nouride kasih channel, approval, misi, memori, dan tool-nya; CLI tetap pegang yang bikin
dia jago ngoding: context-nya sendiri, prompt-nya sendiri, tool file dan shell-nya sendiri.

Ada dua bawaan: **Claude Code** dari Anthropic dan **Codex** dari OpenAI. Nouride menjangkau keduanya lewat
[Agent Client Protocol](https://agentclientprotocol.com) (ACP), melalui adapter yang terdaftar untuk masing-masing di
[registry ACP](https://agentclientprotocol.com/registry), adapter yang sama yang dipakai editor Zed dan JetBrains:

- [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp), yang penulisnya di registry adalah
  Anthropic, Zed Industries, dan JetBrains;
- [`codex-acp`](https://github.com/agentclientprotocol/codex-acp), dari OpenAI, JetBrains, dan Zed Industries.

Tiap adapter membawa CLI aslinya, login pakai login CLI itu sendiri, jadi langganan Claude atau ChatGPT kamu dipakai
dengan cara yang didukung pembuatnya, bukan lewat akal-akalan: Nouride gak mengubahnya jadi API, gak meniru CLI-nya, dan
gak menyerahkan login-nya ke program lain. Satu-satunya yang Nouride tanyakan dengan login itu adalah berapa banyak
pemakaian akunnya, pertanyaan yang sama yang ditanyakan halaman pemakaian CLI itu ke pembuatnya. Apa yang boleh
dilakukan sebuah langganan tetap ditentukan oleh ketentuan pembuatnya.

Tiga lagi sudah bawaan, masing-masing bicara ACP sendiri, tanpa adapter: **Antigravity** dari Google (`agy`),
**Cursor CLI**, dan **Grok Build** dari xAI (`grok`). Ketiganya ditandai **Experimental**: masing-masing sudah di-install,
dijalankan, dan dimintai sesi di box Linux tanpa akun, tapi belum ada yang menjawab satu giliran pun di akun sungguhan.
Dashboard menyebutnya di samping nama mereka, di daftar CLI dan di tempat CLI sebuah agent dipilih. Mereka bisa saja
gak menjawab, atau menjawab sebagian; laporkan lewat issue kalau ada yang gak jalan.

## Meng-install CLI

Nouride gak ikut membawa CLI apa pun. Masing-masing di-install lewat npm, sebagai adapter-nya, yang sudah membawa CLI
itu sendiri:

| CLI | Paket | Perintah yang dijalankan Nouride | Butuh |
|---|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` | `claude-agent-acp` | Node 22 ke atas |
| Codex | `@agentclientprotocol/codex-acp` | `codex-acp` | npm |

Tiga yang ditandai Experimental di-install dengan skrip pembuatnya sendiri. **Set it up** di kartunya meminta
orkestrator, sama seperti dua di atas; kalau manual cukup satu perintah, dijalankan root seperti `nouride tools run`:

| CLI | Install | Perintah yang dijalankan Nouride |
|---|---|---|
| Antigravity | `sudo nouride agents install antigravity` | `agy acp` |
| Cursor CLI | `sudo nouride agents install cursor` | `cursor-agent --disable-auto-update acp` |
| Grok Build | `sudo nouride agents install grok` | `grok --no-auto-update agent stdio` |

Perintah itu menjalankan installer pembuatnya sebagai user daemon, lalu menyalin hasilnya ke `.nouride/opt` dan
menautkannya ke `.nouride/bin`, tempat user setiap agent menjalankannya: installer-nya menaruh CLI di folder home user
yang menjalankannya, yang gak bisa dibaca user para agent. Installer Cursor menamai perintahnya `agent`, sama seperti
installer Grok, jadi Cursor dijalankan dengan nama sendiri, `cursor-agent`. Updater bawaan mereka dimatikan: milik
Antigravity lewat sebuah setelan, milik Grok dan Cursor lewat sebuah switch di setiap perintah yang dijalankan Nouride
(switch Cursor dibaca dari kodenya; bahwa dia bertahan saat ada update belum terlihat). Nouride gak mengecek versinya ke
registry npm, karena gak ada yang rilis di sana.

- **Linux**, yang di-install pakai `install.sh`: `sudo nouride tools run -- npm i -g @agentclientprotocol/claude-agent-acp`
  (atau `@agentclientprotocol/codex-acp`). `nouride tools run` menjalankan installer sebagai user daemon, menaruh
  program-nya di `.nouride/bin`, dan membuatnya bisa dijalankan semua agent; `nouride` di `PATH` jalan sebagai akun
  layanan kalau dijalankan root. Node dan npm diambil dari sistem: cek `node --version`, karena paket bawaan sebuah
  distro bisa lebih tua dari 22.
- **macOS**: `npm i -g @agentclientprotocol/claude-agent-acp` sebagai dirimu sendiri, dengan Node dari Homebrew. Daemon
  jalan sebagai kamu, dengan Homebrew paling depan di `PATH`-nya.
- **Docker**: Node.js dan npm sudah ada di image (0.8.46; Node 24, dari paket Alpine di image itu). Install
  adapter-nya ke volume, supaya tetap ada setelah container dibuat ulang:
  `docker exec -u bun -e NPM_CONFIG_PREFIX=/app/.nouride nouride npm i -g @agentclientprotocol/claude-agent-acp`.
  Image sebelum 0.8.46 gak punya Node: di sana, `docker exec nouride nouride pkg install nodejs npm` dulu (tetap ada
  setelah container dibuat ulang).

Atau minta orchestrator lewat chat: dia meng-install salah satunya untuk semua agent, setelah admin bilang ya (sejak
0.8.9 cuma admin yang menjawabnya, di chat satu-satu juga: install-nya jalan sebagai user daemon). Dashboard bisa
memintakannya untukmu (0.8.19): kalau sebuah CLI belum ada di box, **Models → Coding CLIs** dan tab **Brain** milik
agent eksternal punya tombol **Ask Nouva to set it up** (dengan nama orchestrator-mu), yang membuka chat di atas
halaman itu dengan permintaannya sudah tertulis, untuk kamu baca lalu kirim.

`nouride agents scan` menampilkan CLI yang ada di box, masing-masing dengan perintah yang dijalankan Nouride dan semua
yang dipakainya untuk jalan (0.8.38): Node, adapter-nya, CLI yang dibawa adapter itu, dan paket-paket lain milik
adapter, masing-masing dengan versinya. Versi CLI-nya sendiri bukan versi adapter: `claude-agent-acp 0.107.0` membawa
Claude Code 2.1.323, dan versi CLI itulah yang menentukan model apa saja yang dia punya. Jadi halaman **Models** dan tab
**Brain** agent-nya menyebut CLI dengan versinya sendiri, sisanya di bawah Details, dan `/status` di chat juga
menyebutnya. Agent-nya pun diberi tahu apa yang menjalankannya, dibaca dari berkas yang ter-install, jadi kalau ditanya
"kamu pakai Claude Code versi berapa?" dia gak menebak dari salinan lain yang ada di box.

Tiap CLI bawaan juga bilang posisi versinya dibanding versi terbaru yang sudah rilis, yang Nouride tanyakan ke registry
npm sehari sekali, dan dibanding versi-versi yang sudah dites dengan Nouride ini: sudah terbaru, ada versi baru, lebih
baru dari yang pernah dites dengan Nouride ini (tetap jalan, dengan peringatan), atau lebih lama dari yang didukung.
Versi baru ditawarkan begitu rilis, sudah dites dengan Nouride ini atau belum; yang belum dites bilang begitu di samping
tawarannya, dan kamu yang memutuskan mau ambil atau tidak. Kalau ada CLI lebih baru yang belum dibawa adapter mana pun,
badge-nya bertuliskan **newest you can get**, tanpa tombol apa pun. **Home** memberi tahu admin kalau CLI yang dipakai
sebuah agent punya update. Tiap minggu CI Nouride sendiri meng-install versi terbaru tiap CLI dan mengecek handshake-nya
tanpa login; versi yang lolos itu dan satu giliran sungguhan disebut sudah dites di rilis berikutnya.

**Update** di sana meminta orchestrator, lewat pesan yang kamu kirim, menjalankan `nouride agents update <cli>`. Dia
menunggu sampai gak ada giliran yang jalan di CLI itu, dan gak memulai yang baru selama menunggu; meng-install versi
yang ditawarkan, yaitu yang terbaru, seperti `nouride tools run` meng-install; lalu menyalakan CLI-nya lagi dan
mengecek handshake-nya untuk hal yang dipakai Nouride: steering, dan mode yang dipasang preset-nya. Pengecekannya gak
mengirim prompt. Versi yang gak lolos cuma menghentikan agent-agent CLI itu, dengan alasannya, dan versi sebelumnya
ditawarkan kembali: **Ask … to put it back** di tab Brain agent-nya, atau `nouride agents update <cli> <versi>`.
Setelah update, daftar model tiap agent dibaca ulang dari versi baru, di sesi berikutnya. Updater bawaan CLI-nya tetap
mati, dan agent yang dijawab CLI gak bisa menjalankan update itu sendiri, karena update menghentikan CLI-nya sendiri:
dia minta ke orchestrator, atau menyuruh kamu.

## Membuat agent eksternal

**Agents → New Agent** membuatnya seperti agent lain (nama, headline, dan persona), lalu di **Answered by** ada
CLI yang terpasang di box, kemudian **akun** yang dipakai. Membuat agent itu urusan admin; operator melihat New Agent
dalam keadaan nonaktif. Dari terminal, `nouride agent external <id> <cli>` mengubah agent yang sudah ada jadi agent
eksternal, dan `nouride agent internal <id>` mengembalikannya ke model-nya.

Atau minta ke orchestrator lewat chat. Dia menanyakan agent itu untuk apa dan seperti apa, meng-install CLI-nya kalau
box belum punya (setelah kamu bilang ya), membuat agent-nya, lalu mengirim link ke tab Brain-nya: login-nya kamu yang
lakukan, di sana, bukan di chat. Model Nouride untuk agent itu adalah default install, atau model orchestrator kalau
install gak punya default.

Box kecil mungkin gak cukup. Diukur dengan satu sesi terbuka dan diam, sebelum mengerjakan apa pun, Claude Code makan
sekitar 330 MB dan Codex sekitar 190 MB, dan saat kerja lebih dari itu. Kalau perintah agent cuma kebagian di bawah
512 MiB, daftarnya bilang begitu dan gak menawarkan apa-apa; `nouride agents scan` bilang hal yang sama.

## Login

Satu akun adalah satu login ke sebuah CLI. **Models → Coding CLIs** menampilkan akun tiap CLI, agent di tiap akun, dan
apakah mereka bisa menjawab. Setiap akun di-login-kan di situ, sekali: **Add an account**, atau **Sign in** di akun yang
sudah ada, menjalankan login milik CLI itu sendiri di box, dan halamannya menampilkan apa yang dicetak. Setelah itu
agent tinggal dipasang ke akun itu, di tab **Brain**-nya atau waktu dibuat, dan menjawab pakai login tersebut. Agent di
akun yang sama berbagi limit akun itu, termasuk jendela lima jam-nya. Login dan menyimpan tab Brain sebuah agent itu
urusan admin.

- **Claude Code** menjalankan `setup-token` miliknya sendiri. Buka link yang dicetak, login pakai langganan Claude kamu,
  lalu tempel balik kode yang ditunjukkan halaman itu. Nouride menyimpan token jangka panjang yang dicetaknya di secret
  store, gak pernah di halaman, dan memberikannya ke Claude Code tiap agent di akun itu waktu dinyalakan.
- **Codex** mencetak link dan kode sekali pakai: buka link-nya, login ke ChatGPT, ketik kodenya di halaman OpenAI, dan
  login-nya selesai sendiri. Login device-code harus dinyalakan dulu, di pengaturan keamanan akun ChatGPT kamu.
- **Antigravity** (Experimental) login dengan akun Google yang berlangganan Google AI Pro atau Ultra: dia mencetak link,
  dan kamu tempel balik kode yang ditampilkan halaman Google.
- **Cursor CLI** (Experimental) login dengan akun Cursor: dia mencetak link untuk dibuka; login-nya selesai sendiri.
- **Grok Build** (Experimental) login dengan akun Grok yang berlangganan SuperGrok atau X Premium+: dia mencetak link dan
  kode untuk diketik di halaman xAI.

Semua CLI selain Claude Code menyimpan login-nya dalam file, bukan mencetak token. File itu disimpan di folder milik
akun, di folder data Nouride yang gak bisa dibaca agent, lalu ditulis ke folder agent waktu CLI-nya dinyalakan. Sebuah
CLI sesekali memperbarui login-nya; setelah tiap gilirannya, yang diperbarui disalin balik ke akun, jadi agent
berikutnya yang menyala di akun itu dapat yang terbaru. Dua agent di satu akun yang bekerja di saat yang sama masih bisa
saling menimpa pembaruannya, dan salah satunya lalu diminta login lagi: satu akun per agent menghindari itu. Agent yang
dulu login sendiri (`nouride agents login <id>` di terminal masih bisa) tetap memakai login itu sampai akunnya
di-login-kan di halaman.

CLI yang kamu tambahkan sendiri login pakai kata-kata `login`-nya sendiri. Kalau login lewat browser-nya berakhir di
halaman di box yang gak bisa dibuka dari mesin kamu, tempel balik alamat halaman itu, dan Nouride membukanya di box.

### Kalau sebuah akun kena limit

Satu agent bisa punya lebih dari satu akun untuk menjawab (0.8.38). Di tab **Brain**-nya, **When its account reaches its
limit** berisi akun-akun lanjutannya, berurutan, dipilih dari akun yang sudah login di **Models → Coding CLIs**. Begitu
akun yang sedang dipakai kena limit pemakaian, Nouride menyalakan CLI-nya di akun berikutnya dan mengirim ulang pesan
itu, satu kali. Percakapannya berlanjut: sesi CLI disimpan di folder agent, dan yang berganti cuma login yang dipakai
saat menyala. Chat-nya mendapat satu baris yang menyebut akun mana yang kena limit, sampai kapan, dan akun mana yang
dipakai agent selanjutnya.

- Limit sering cuma milik satu model, jadi dicatat per akun dan per model: akun yang kena limit untuk satu model masih
  menjawab di model lain.
- Akun yang kena limit dilewati sampai limitnya berakhir, kalau CLI menyebut kapan. Kalau tidak, akun itu bisa dicoba
  lagi setelah satu jam. Catatan ini bertahan setelah restart.
- Agent yang sudah pindah tetap di akun tujuannya, selama akun itu sendiri belum kena limit. Setelah Nouride restart,
  dia mulai lagi dari atas daftarnya, di akun pertama yang tidak kena limit.
- Tiap agent pindah menurut daftarnya sendiri. Agent-agent yang berbagi satu akun sama-sama tahu akun itu kena limit,
  dan masing-masing pindah ke akun berikutnya miliknya; gak ada yang diganti untuk semua agent sekaligus, dan login
  satu agent gak pernah jadi milik agent lain.
- Kalau semua akun di daftar kena limit, gak ada yang dikirim. Kalau tiap limit menyebut kapan berakhirnya, pesan itu
  ditahan sampai yang pertama berakhir, seperti di bawah. Kalau ada yang gak menyebut, model agent itu sendiri yang
  menjawab pesan tersebut dan menyebut akun mana saja yang habis, dan sampai kapan.

**Sebelum kena limit.** Agent juga bisa pindah sebelum ada pesan yang ditolak. Di tab Brain-nya, di bawah daftar akun,
nyalakan **Move on before the limit** dan atur berapa bagian dari limit yang terpakai saat dia pindah, awalnya 90%.
Claude Code menyebut seberapa banyak limit sebuah akun sudah terpakai selama bekerja (limit lima jam dan limit
mingguan, masing-masing dengan kapan mulai lagi). Begitu yang paling penuh sudah mencapai angka agent itu, dia
menyelesaikan pesan yang sedang dijawab, dan pesan berikutnya mulai di akun selanjutnya, dengan satu baris di chat yang
bilang begitu. Gak ada yang terpotong atau terkirim dua kali. Fitur ini mati kecuali kamu nyalakan, dan hanya
ditawarkan kalau CLI-nya menyebut pemakaian akun.

- Akun itu dilewati, oleh agent-agent yang meminta fitur ini, sampai limit tersebut mulai lagi.
- Tiap agent memakai angkanya sendiri: yang gak meminta tetap di akun itu, dan yang angkanya lebih tinggi tetap di sana
  sampai angkanya sendiri tercapai.
- Kalau semua akun lain juga sudah dekat limit, atau sudah kena, agent tetap di tempatnya sampai limit itu sendiri.

### Berapa banyak pemakaian sebuah akun

**Models → Coding CLIs** menampilkan, di bawah tiap akun, berapa banyak paketnya sudah terpakai: tiap limit dengan
persentase yang terpakai, sebuah bar, dan kapan limit itu mulai lagi. Nouride menanyakannya ke pembuat akun paling
sering tiap lima menit, pertanyaan yang sama yang ditanyakan halaman pemakaian CLI-nya, dengan login akun itu sendiri,
dan di antara pembacaan itu memakai apa yang dikatakan CLI-nya selagi bekerja, kalau dia mengatakannya, dan menyebutnya
begitu. Kalau gak ada yang mengatakannya, akun itu bertuliskan **How much of its plan is used is not known**. Kalau CLI
sebuah agent memperbarui login-nya di folder agent itu sendiri (Codex, Cursor CLI, Grok Build, Antigravity, atau Claude
Code dengan login milik agent sendiri), pemakaian tiap agent ditampilkan di bawah namanya.

| CLI | Yang ditampilkan |
|---|---|
| Claude Code | Limit lima jam dan mingguan, dan limit mingguan milik sebuah model kalau ada |
| Codex | Limit pendek dan mingguan, dan apakah masih ada kredit di luar limit itu |
| Cursor CLI | Pemakaian paket di siklus tagihan ini, dipisah antara Auto dan model bernama kalau Cursor memisahkannya |
| Grok Build | Kredit paket yang terpakai di periode ini, dibaca dari Grok Build selagi ada agent di akun itu yang berjalan |
| Antigravity | Belum diketahui: dia belum mengatakan apa pun soal pemakaiannya |

Akun yang login sekali untuk agent-agentnya dilewati sampai sebuah limit mulai lagi, sebelum ada pesan yang dikirim ke
sana lalu ditolak, kalau pembuatnya bilang limit itu sudah habis dan gak ada kredit lagi di luarnya (kredit Codex, extra
usage Claude). Limit milik sebuah model melewatinya hanya untuk model itu. Kalau pembuatnya bilang masih ada kredit, atau
gak bilang apa-apa soal itu, akunnya gak dilewati: dulu dia menjawab, dan sekarang tetap menjawab. Pembacaan berikutnya
yang menunjukkan ada ruang lagi (kredit dibeli, extra usage dinyalakan, limit yang mulai lagi lebih awal) membuatnya
langsung bisa menjawab lagi.

Pesan yang ditolak karena limit akun yang menyebut kapan berakhirnya, saat agent gak punya akun lain untuk lanjut,
ditahan: chat diberi tahu bahwa agent akan lanjut sendiri begitu limit itu berakhir, dan saat itu dia memang lanjut,
seolah kamu bilang "continue". Ini berlaku entah CLI-nya sudah mulai menjawab atau belum. Ini tetap tersimpan meski
Nouride restart. Pesan itu gak ditahan kalau kamu sudah mengatakan sesuatu di chat itu sejak saat itu (orang lain di
sebuah room, atau job terjadwal, gak dihitung), atau kalau limitnya baru berakhir lebih dari delapan hari lagi; di situ,
bilang "continue" sendiri. CLI yang belum login gak ditahan: itu langsung disebut, dengan kartunya untuk login.

**Models → Coding CLIs** juga menyebut, di bawah tiap akun, limit yang sedang mengenainya atau yang sudah dekat, dan di
samping agent yang pindah dari akun itu, di mana agent tersebut sekarang. `/status` di chat menyebut akun yang sedang
dipakai agent. Di pack-nya, ini satu field yang sama, berupa daftar, dengan angkanya di sampingnya:

```toml
[external]
cli = "claude-code"
profile = ["work", "second"]
move_at = 90                        # opsional: pindah begitu 90% dari sebuah limit terpakai
```

Untuk CLI yang login-nya berupa file, seperti Codex, Nouride belum bisa tahu kapan sebuah akun kena limit, jadi
daftarnya gak ditawarkan.

Akun mana yang masuk daftar, kamu yang memutuskan. Satu langganan itu milik satu orang, dan ketentuan pembuatnya yang
mengatur boleh dipakai untuk apa: berpindah-pindah di antara akun beberapa orang untuk melewati limit mereka bisa
melanggar ketentuan itu.

## Cara jalannya

Satu proses CLI per agent, dinyalakan di giliran pertamanya dan dimatikan setelah lima menit diam; pesan berikutnya
menyalakannya lagi. CLI yang masih menjalankan perintah yang ia tinggal di background tidak dimatikan, dan update atau
restart menunggu perintah itu seperti menunggu job background. Tiap percakapan
punya sesi CLI-nya sendiri, dibuka lagi setelah restart kalau CLI-nya bisa. Kalau
tiap agent [punya user sendiri](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri), CLI jalan sebagai user
itu, dengan folder agent sebagai HOME-nya.

Yang dibilang CLI sendiri di antara giliran sampai ke chat. Claude Code lanjut tanpa pesan saat perintah yang ia
tinggal di background selesai: ia baca hasilnya dan bilang apa jadinya. Itu datang sebagai pesan agent sendiri,
seperti hasil job background. Begitu juga helper yang dinyalakan Claude Code di background (0.8.39): giliran agent di
chat selesai begitu ia selesai dengan bagiannya, chat bebas selama helper kerja, dan hasilnya datang sebagai pesan
agent sendiri. Giliran sebuah misi tetap menunggu helper seperti itu. Kalau kamu nulis duluan, pesan itu datang sebelum jawaban buat pesanmu. Kalau Nouride
dihentikan langsung atau crash waktu perintah itu masih jalan, agent bilang begitu setelah restart.

Tab **Brain** agent eksternal, menggantikan tab Model, berisi CLI-nya, akun yang dipakai (**In use**; akun lain dipilih
lewat **Use for …**), dan yang ditulis ke `[external]` di `config.toml` agent:

- **Model**: sesuai nama dari CLI-nya; setelah satu sesi terbuka, kolomnya menampilkan model yang ditawarkan CLI itu.
  Kosong berarti default CLI.
- **Apa yang boleh dilakukan tanpa nanya**: salah satu dari tiga preset, masing-masing adalah mode CLI itu sendiri:

| Preset | `permissions` | Mode Claude Code | Mode Codex | Mode Antigravity |
|---|---|---|---|---|
| Free in its folder | `folder` | `bypassPermissions` | `agent-full-access` | `auto` |
| Ask when risky | `risky` | `acceptEdits` | `agent` | `accept-edits` |
| Ask for everything | `all` | `default` | `read-only` | `default` |

Cursor CLI dan Grok Build belum punya mode yang diatur Nouride: mereka mulai di mode mereka sendiri. Di *Free in its
folder*, apa pun yang masih ditanyakan CLI sebelum bertindak langsung diizinkan Nouride tanpa nanya kamu (mode `auto`
Antigravity masih nanya sebelum hal yang gak bisa dibatalkan); di dua preset lainnya, pertanyaan itu lewat approval
Nouride.

*Free in its folder* gak nanya apa-apa, termasuk sebelum push, POST, atau `ssh`. Preset ini bebas hanya kalau tiap agent
punya user sendiri, yaitu service Linux dengan helper `nouride-run`, di mana sistem operasi menjaga CLI dari semua yang
bukan milik agent-nya. Di Docker, di macOS, atau tanpa helper, CLI jalan sebagai user daemon, yang bisa membaca database
dan secret store, jadi di sana dia nanya seperti *Ask when risky*, apa pun kata pack-nya; tab Brain tetap menampilkan
pilihan pack. Kalau apa yang dia kirim keluar itu penting, pilih *Ask when risky*. Pack yang gak menyebut preset dapat
*Free in its folder* kalau tiap agent punya user sendiri, dan *Ask when risky* di tempat lain. Preset atau model yang
diubah berlaku di percakapan yang sedang jalan mulai pesan berikutnya.

Di bawahnya, terlipat, ada model Nouride sendiri untuk agent itu, beserta fallback-nya: model yang menjawab pesan yang
gak bisa dijawab CLI.

```toml
[external]
cli = "claude-code"
profile = "work"
permissions = "risky"
model = "sonnet"
```

### Persona, login, dan skill-nya

Siapa dia diambil dari file persona-nya, di tab Files seperti agent lain: `IDENTITY.md`, `SOUL.md`, `AGENTS.md`,
`MEMORY.md` di pack-nya. Tiap sesi dibuka, Nouride menuliskannya ke file instruksi CLI itu, di antara penanda yang
Nouride jaga: `workspace/private/<id>/CLAUDE.md` untuk Claude Code, dan untuk Codex `AGENTS.md` di folder profilnya
(di bawah), yang dibaca Codex di folder mana pun ia bekerja, termasuk mission di repository kamu (mulai 0.8.4;
sebelumnya mission di sana berjalan tanpa persona agent-nya). Baris kamu sendiri di file itu, di atas atau di bawah
penanda, tetap utuh; `AGENTS.md` yang di sana milik CLI, bukan milik pack.

CLI bisa punya memori sendiri, karena prompt bawaan Claude Code menyuruhnya begitu. Nouride dan agent lain gak membacanya, jadi
blok itu memberi tahu CLI bahwa yang perlu bertahan disimpan di `MEMORY.md` lewat `memory_write`, dan yang ia pelajari
tentang seseorang di fakta orang itu (mulai 0.8.10). Pesan pertama tiap giliran juga memberi tahu jam sekarang di
`[daemon] timezone`, dan (sekali per percakapan, termasuk percakapan job terjadwal, lalu lagi kalau berubah) cara
menulis di tempat kata-katanya dikirim: di Telegram, tanpa tabel.

Login dan pengaturan tiap akun adalah satu folder profil, `workspace/private/<id>/.cli/<cli>/<profile>`
(`.cli/codex/default`), yang ditunjuk ke CLI lewat `CLAUDE_CONFIG_DIR` atau `CODEX_HOME`. Akun Claude Code yang
login di halaman Models disimpan sebagai token di secret store.

Skill-nya (yang menyala di tab Skills) disalin ke folder `skills` di profil itu, yang dibaca CLI di folder mana pun
dia kerja, termasuk repo sebuah misi: saat sebuah skill dinyalakan atau dimatikan, dan sebelum tiap pesan. Skill yang
kamu taruh sendiri di folder itu tetap utuh, dan skill yang butuh tool Nouride yang gak bisa dipanggil CLI-nya gak ikut
disalin. CLI yang kamu tambahkan sendiri gak dapat skill; tab Skills-nya bilang begitu.

CLI membaca daftar skill-nya saat sebuah percakapan dimulai dan memakai daftar itu terus, jadi perubahan baru berlaku di
percakapan yang baru mulai: di chat yang sedang jalan, kirim `/new` atau `/reset`. Keduanya juga memulai ulang sisi CLI
(sesi baru, tanpa sisa percakapan sebelumnya), sama seperti rollover dan hapus percakapan dari dashboard.

### Tool Nouride yang dipinjamkan

Selama satu giliran jalan, dan hanya saat itu, CLI dipinjami tool Nouride lewat MCP: `ask_agent`, `delegate`,
`memory_search`, `memory_read`, `memory_analyze`, `memory_write`, `person_notes`, `person_record`, `plan`, `notes`,
`schedule`, `mission`, `work`, `send_message`, `send_file`, `agent_configure`, `persona`, `skill_root`, `agent_create`, tool skill
(`skill_create`, `skill_toggle`, `skill_improve`, `skill_search`, `skill_install`), `mcp_search`, `secret_save`, dan
`attachment_read`, juga server MCP milik agent itu dari library, dengan kredensial yang tetap di Nouride. Yang
dipinjamkan cuma yang diizinkan saklar tool agent-nya, dan tiap panggilan lewat gate, approval level, dan audit yang
sama seperti panggilan model. Panggilan yang datang di antara giliran ditolak. Connector claude.ai milik Claude Code,
yaitu tool Gmail, Drive, dan Docs yang ikut terbawa login claude.ai, dimatikan: tool itu menjangkau keluar gate.

Yang bisa dilakukan CLI lewat tool itu, yang tidak bisa ia lakukan sendiri:

- **Skill yang ia buat** masuk ke pool skill rumah seperti skill agent lain: dicek seperti draft, menyala untuk dirinya
  sendiri, muncul di tab Skills supaya agent lain bisa menyalakannya, dan disalin ke folder skill CLI-nya. Skill yang ia
  tulis langsung ke folder itu tetap miliknya sendiri, tidak ada di pool agent lain.
- **File yang dikirim sebelumnya di percakapan** (sebelum `/new`, atau ke agent lain di ruang yang sama) dikembalikan
  `attachment_read` sebagai path di foldernya sendiri, yang bisa dibuka tool file-nya, gambar pun tampil sebagai gambar.
- **Kredensial yang dikirim di chat** tidak pernah sampai ke shell CLI: prosesnya memakai environment saat ia dimulai,
  jadi handle-nya kosong di sana, dan ia diberi tahu soal itu. Kalau diminta menyimpannya, ia memakai `secret_save`,
  dan CLI dimulai ulang dengan kredensial itu di giliran agent berikutnya, setelah tidak ada pekerjaan lain dari agent
  itu yang berjalan, jadi tidak ada percakapan lain yang terpotong. Percakapannya berlanjut dari tempat CLI
  menyimpannya. Giliran yang datang saat giliran lain masih berjalan (misi yang dimulai agent di giliran yang menyimpan
  key itu) menunggu giliran tersebut selesai, paling lama dua menit, supaya ia mulai dengan key-nya; lewat dari itu, atau
  kalau ada perintah yang ditinggal berjalan oleh CLI, ia diberi tahu variabel mana yang belum ada di shell-nya, alih-alih
  meminta key itu lagi ke orangnya.
- **Di grup**, ia diberi tahu setiap agent di sana beserta teks persis untuk men-tag-nya (di Discord, id bot-nya), apa
  tugas masing-masing, dan berapa kali tugas boleh dioper: tag menyerahkan pekerjaan di tempat semua orang melihatnya.
  Di DM ia diberi tahu bahwa `ask_agent` menjangkau mereka dan tag tidak. Disampaikan sekali per percakapan, dan lagi
  kalau agent di ruang itu berubah.

`nouride`, `update`, dan `session_status` tetap milik agent Nouride: dua yang pertama me-restart daemon, dan CLI ikut
mati di tengah giliran; yang ketiga melaporkan sesi model Nouride, yang bukan milik CLI.

## Yang diputuskan Nouride, dan yang diputuskan CLI

Tool milik CLI sendiri (file, shell, web) urusan CLI. Approval level agent, daftar tetap, dan `[tools]`-nya gak
menyentuh tool itu; yang menyentuh adalah preset, sebagai mode CLI itu sendiri. Yang ditanyakan CLI di bawah preset-nya
datang ke kamu sebagai approval Nouride, di chat atau di dashboard, dan di dalam misi di-park seperti approval lain.
Approval level gak pernah menjawabnya atas nama kamu. **Always** cuma ditawarkan kalau CLI-nya punya pilihan always
sendiri, dan aturan itu disimpan oleh CLI, bukan oleh Nouride.

`/model <nama>` di chat memindahkan CLI ke model itu untuk chat tersebut; model milik agent, untuk semua chat, diatur di
tab Brain. Nama itu dicek ke daftar model yang ditawarkan CLI (0.8.38), dan balasannya menyebut nama itu maksudnya apa:
`fable` adalah Fable yang mana pun yang dimiliki versi yang ter-install. Nama yang gak dimiliki CLI ditolak beserta
daftar yang dia punya, bukan baru ketahuan saat pesan berikutnya gagal. `/model` saja menyebut model sekarang dan
pilihannya, dan `/model default` kembali ke model milik agent. Selama CLI belum menyebut daftarnya (sebelum sesi
pertamanya, atau setelah update), nama diterima apa adanya dan balasannya bilang belum dicek.

`/effort high` mengatur seberapa lama CLI berpikir di chat itu, mulai pesan berikutnya, di atas effort milik agent;
sesinya diubah selagi berjalan, jadi CLI tetap memegang percakapannya. Hanya level yang ditawarkan CLI untuk model yang
sedang dipakai yang diterima, dan `/effort` saja menyebut level sekarang dan pilihannya. `/effort default` kembali ke
effort milik agent, atau ke bawaan CLI kalau agent tidak mengaturnya. Effort milik agent diatur di tab CLI-nya, untuk
semua chat, atau dari chat dengan `/effort <level> lock` oleh admin.

`/status` menyebut CLI mana yang menjawab dan model-nya, dan bahwa konteks percakapannya disimpan CLI itu sendiri,
dengan ukuran seperti yang terakhir dilaporkan CLI. Token-nya adalah yang dilaporkan CLI di akhir tiap prompt, termasuk
cache. Token itu dicatat sebagai pemakaian CLI itu sendiri, di luar `max_daily_cost_usd` dan `max_daily_tokens`: CLI
jalan pakai langganannya sendiri.

## Kalau dia gak bisa menjawab

Kalau CLI-nya gak bisa menjawab sebuah pesan (belum login, belum ter-install, atau gagal), model agent itu sendiri yang
menjawab pesan tersebut, diawali satu baris yang bilang begitu, dan CLI menjawab lagi pesan berikutnya begitu bisa. Pesan
yang sudah mulai dijawab CLI, atau yang kamu hentikan, gak dijawab ulang. Baris itu membedakan CLI yang gak menyala dari
CLI yang menyala lalu menolak pesannya (limit akun, misalnya), dan kalau chat itu sedang di model yang dipilih lewat
`/model`, baris itu bilang begitu dan cara kembalinya.

Status-nya bilang kenapa: CLI belum ter-install (beserta cara install-nya), belum login, atau gagal start. CLI sering
update, dan versi baru bisa mengubah hal yang dipakai Nouride: pertama kali sebuah versi start, bagaimanapun cara
install-nya, Nouride mengecek handshake-nya (steering, mode preset-nya; sejak 0.8.24, menggantikan pertanyaan satu baris
yang memakai satu prompt). Versi yang gak lolos menghentikan agent-nya, dengan pesan bahwa versi itu gak lolos pengecekan
Nouride dan versi mana untuk kembali, sampai kamu kembali atau update Nouride. Agent lain tetap jalan.

Agent eksternal gak pernah jadi orchestrator: level approval, fixed list, dan saklar tool Nouride gak menjangkau perintah
CLI-nya sendiri, padahal orchestrator adalah agent yang dijangkau siapa pun di room. Simpanan yang bakal menjadikannya
orchestrator dikembalikan, dan start yang menemukannya di `[daemon] orchestrator` jalan tanpa orchestrator dan bilang
begitu. Dia menjawab di channel-nya sendiri,
di room kalau di-mention, dan lewat `ask_agent`. Pesan yang gak menyebut nama tetap sampai ke agent Nouride.

## Di dalam misi

Satu misi memakai satu sesi CLI dari awal sampai akhir dan kerja di folder misi; checklist-nya adalah plan CLI itu. Di
repo git, di box yang cukup lega, misi kerja di worktree-nya sendiri dengan branch `mission/<id>`, jadi dua misi di repo
yang sama gak saling tunggu, dan misi selesai dengan branch itu. Merge-nya keputusan agent, lewat approval gate seperti
push. Helper yang dikasih kerja lewat `delegate` dengan `isolated` masing-masing dapat worktree dari worktree misi itu,
dengan branch sendiri, untuk di-merge oleh misinya.
[Misi di dalam repo →](/id/docs/manual/missions/#di-dalam-repo)

Misi sebuah CLI dibatasi jam dan token-nya, bukan jumlah turn: ia kerja dalam satu-dua turn panjang dengan banyak
langkah, jadi halaman misinya dan dashboard menghitung turn dan langkahnya tanpa angka batas di sampingnya. Jam dan
token-nya menghentikan turn yang sedang jalan: CLI diminta berhenti, dan misi menunggu kamu. CLI baru bilang berapa
token yang dipakai sebuah prompt saat prompt itu selesai, jadi selama jalan token-nya diperkirakan dari ukuran konteks
yang dilaporkan CLI tiap langkah; angka dari CLI di akhir menggantikan perkiraan itu. Kalau CLI-nya gak melaporkan
token sama sekali, token-nya tampil sebagai unknown. Di preset `folder`, gak ada yang bertanya sebelum ia menghapus
sesuatu, di dalam folder misi maupun di luarnya. Satu-satunya batas adalah hak user Linux-nya, dan halaman misinya
bilang begitu ke CLI itu.

## CLI tambahan

CLI apa pun yang bicara Agent Client Protocol bisa ditambahkan di `config.toml` daemon:

```toml
[[external_clis]]
id = "opencode"
name = "OpenCode"
command = "opencode"
args = ["acp"]
install = "npm i -g opencode-ai"
login = ["auth", "login"]
status = ["auth", "status"]       # keluar 0 kalau sudah login; tanpa ini: dilihat dari sesi yang dibuka
profile_env = "OPENCODE_HOME"   # kalau gak diisi: profilnya adalah HOME-nya
modes = { folder = "build", all = "plan" }
```

Secret yang dia butuhkan diikat ke perintahnya di `[security.exec_secrets]`; baris ini gak punya `env`. `id` yang sama
dengan CLI bawaan (`claude-code`, `codex`) ditolak saat dimuat. `id` milik CLI bawaan yang ditandai Experimental
(`antigravity`, `cursor`, `grok`) jadi milikmu: baris kamu dipakai menggantikannya, dan start menyebutnya sekali, sama
seperti `nouride config check`. CLI tambahan jalan sebagai user agent itu sendiri hanya
kalau tiap agent punya user sendiri, gak dapat skill, dan, kalau punya `login`, di-login-kan di akun seperti yang lain.
[Semua key →](/id/docs/reference/config/#external_clis)

## Nouride di editor kamu

Arah sebaliknya: agent kamu di Zed, atau editor apa pun yang bicara ACP. Editor menjalankan `nouride acp --agent <id>`
di mesin tempat daemon jalan; tanpa `--agent`, orchestrator yang menjawab:

```json
{ "agent_servers": { "Nouride": { "command": "nouride", "args": ["acp", "--agent", "nouva"] } } }
```

User yang menjalankan editor harus bisa membaca control token install ini: di install Linux, masuk ke grup `nouride`,
atau kasih editor `NOURIDE_URL` dan `NOURIDE_TOKEN` di environment-nya.

Agent-nya tetap kerja di daemon seperti biasa, dengan tool, approval, dan memorinya sendiri; editor menampilkan
pikirannya, tiap panggilan tool, dan jawabannya selagi terjadi, dan menanyakan ke kamu apa yang ditanyakan approval
agent itu. Buka editor di folder yang bisa dijangkau agent, yaitu salah satu `[workspace] roots`-nya.
