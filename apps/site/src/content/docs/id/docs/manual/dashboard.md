---
title: Dashboard
description: Berkeliling antarmuka web, untuk apa setiap halaman, dan antrean-antrean yang sering tertukar.
---

Dashboard adalah aplikasi React yang disajikan langsung oleh daemon, di port yang sama dengan
segalanya:

```
@@DASHBOARD_URL@@
```

Ini antarmuka operator untuk apa pun yang dimiliki **agent**. Ia bukan versi murahan dari CLI: wizard
setup dan `nouride setup` menjalankan kode yang sama, dan halaman Skills menulis file yang sama dengan
`nouride skills on|off`.

![Home: yang butuh kamu, yang sedang jalan, dan Quick chat](/media/dashboard-overview.png)

## Peta

Menunya diurutkan menurut seberapa sering halamannya dibuka: **Home, Chats, Work, dan Agents** tiap hari, **Skills**,
**Connectors** dan **Memory** sesekali, dan semua yang cukup diatur sekali ada di balik **Settings**.

```
Home                yang butuh kamu · yang sedang jalan · Quick chat · agent kamu · box-nya · pemakaian AI hari ini
Chats               agent dan room kamu dalam satu daftar, plus grup tempat mereka ada di aplikasi chat
Work
  Waiting for you   tool call yang ditunggu agent, dan misi yang menunggu jawabanmu
  Missions          kerjaan panjang yang diselesaikan agent sendiri: yang butuh kamu, yang jalan, yang selesai; Limits
  Helpers           helper, perintah dan agent yang ditanya, yang dibiarkan agent jalan: langkahnya, Stop
  Schedule          semua job: buat, ubah, jalankan sekarang; filter aktif / dijeda / gagal
  Webhooks          endpoint yang menjalankan job saat dipanggil, bukan saat jam tertentu
Agents
  Agents            daftarnya, New Agent (admin), dan Settings seluruh daemon
    └ <agent>
        Files           IDENTITY.md, SOUL.md, AGENTS.md, MEMORY.md, config.toml
        Model           provider profile dan model yang dipakai agent ini
        Brain           milik agent eksternal, menggantikan Model: CLI, akun, preset, dan model-nya,
                        plus model Nouride sendiri untuknya
        Connections     bot dan nomor tempat ia menjawab
        Access          apakah ia menerima pengirim baru, seberapa banyak ia bertanya, jumlah pengirimnya
        Skills          semua skill di kumpulan, dan mana yang dibawa agent ini
        Connectors      server MCP instalasi yang dipakai agent ini
        Settings        batas tool dan turn-nya, job senyap, dan tool apa saja yang dimilikinya
        Look            kucingnya di Office
  Office            status para agent sebagai kantor kecil berisi kucing

Skills              Skills Workshop: Live · Pending · Explore
Connectors          server MCP instalasi: Installed · Explore, saklar per agent
Memory
  Knowledge & Memory   Knowledge · Agent notes · People · Timeline · Shared · Proposals · Settings, dan graph
  People            nama dan catatan untuk manusia yang mereka ajak bicara
  Groups            ruangan tempat mereka bicara: nama tiap ruangan, agent-nya, siapa yang bicara di sana

Settings
  Models and keys
    LLM Gateway     Nougate di dalam daemon: nyala atau mati, akun, pemakaian (admin)
    Models          Model providers: endpoint, wire format, kredensial;       (admin)
                    Coding CLIs: akun tiap CLI dan login-nya;
                    Model tiers (tombol): tiga tingkat, milik tiap helper
    Secrets         kredensial, untuk apa masing-masing, password backup      (admin)
  Reaching out
    Integrations    aplikasi AI lain yang menjangkau memori, satu key per aplikasi (admin)
    Web Search      tempat agent mencari: sumber gratis, Brave, Exa, SearXNG, sendiri (admin)
  People and sign-in
    Access          siapa yang boleh bicara dengan agent: Pending · Approved · Denied · Blocked · History
    Users           akun dan peran (edisi Pro)                                (admin)
    My Account      username, nama, password
  This box
    My Box          perangkatnya sendiri (hanya Box yang sudah dipasangkan)   (admin)
    Logs            Daemon · Audit · Schedule · Helpers
    Update          versi yang jalan, rilis terbaru, dan cara memasangnya
```

Work, Agents, dan Memory masing-masing berisi beberapa halaman, tampil sebagai tab di bagian atas tiap halamannya.
Setiap tab tetap punya alamat sendiri, jadi link ke salah satunya tetap membukanya. Work terbuka di **Waiting for
you**, dan angka di sebelah Work di menu adalah jumlah yang menunggu di sana.

**Settings** adalah halaman berisi kartu dalam empat kelompok, tiap kartu dengan satu baris tentang gunanya halaman
itu, plus kotak pencarian yang menemukan halaman dari namanya atau baris itu. **Restart**, **Documentation**, dan
**Community** (server Discord Nouride) ada di bagian bawahnya. Di sidebar, halaman-halaman milik Settings cuma tampil di bawahnya selagi kamu sedang di Settings atau
di salah satunya.

Halaman khusus admin **gak muncul** di menu maupun di Settings bagi yang gak boleh memakainya, bukan muncul lalu
menolak.

Di bagian bawah sidebar, **Your box** menunjukkan apakah box-nya jalan dengan baik dan versi berapa yang jalan, plus
sebuah tombol kalau ada versi yang lebih baru. Kartunya sendiri membuka Settings.

Judul tab browser menghitung semua yang menunggu kamu, `(2) Nouride`, jadi tab yang ditinggal di belakang tetap
memberi tahu.

**Di HP**, ada bar tab di bagian bawah berisi Home, Chats, Work, dan Agents, dengan angka milik Work di situ, plus
**More**, yang membuka sisa menunya sebagai lembar yang naik dari bawah.

**Di layar utama HP**, dashboard terbuka seperti aplikasi: ikonnya kucing Nouride, Chats tampil duluan, di jendelanya
sendiri. Buka dashboard di alamat `https://`-nya. Chrome atau Edge menawarkan **Install** (di bilah alamat, atau di menu
browser sebagai **Add to Home screen**). Di iPhone, buka di Safari, tekan **Share**, lalu **Add to Home Screen**.
Aplikasinya punya login sendiri, jadi kamu login sekali di dalamnya. Setelah box di-update, aplikasinya langsung membuka
versi baru, sama seperti di browser.

**Di Chats** menunya dilipat jadi ikon saja, supaya daftar chat dan percakapannya muat berdampingan. **Expand** di bawah
menu yang terlipat membukanya lagi, dan browser mengingat pilihan itu. Halaman lain tetap dengan menu penuh, dan HP tetap
dengan bar tab-nya.

**Tampilannya** krem lembut di siang hari dan ungu keabuan di malam hari. Ia mengikuti setelan perangkatmu sampai kamu
memilih sendiri lewat tombol matahari atau bulan di sebelah namamu. Kucing Nouride menyapa kamu di Home, menemani
di halaman yang masih kosong, dan duduk di sebelah judul halaman seperti Schedule dan Secrets. Selama halaman dimuat,
kamu melihat kerangkanya: bentuk abu-abu di tempat isinya nanti muncul.

**Update** adalah kartu di Settings, bukan entri menu. Versi di bawah logo menampilkan titik kalau ada rilis yang lebih
baru, dan badge di bagian atas Home atau tombol di **Your box** membuka halamannya. Cek, unduh, dan pasang adalah tiga
langkah terpisah, karena cuma yang terakhir yang me-restart daemon, dan itu pun menunggu sampai gak ada yang jalan.
[Update →](/id/docs/deployment/updating/)

**Restart**, di sebelah badge update di bagian atas Home, me-restart daemon untuk perubahan yang membutuhkannya. Ia
bertanya dulu, menunggu sampai gak ada yang jalan, menawarkan **Restart now** selama menunggu, dan memberi tahu begitu
daemon kembali. Cuma admin atau operator yang melihatnya, di situ dan di bagian bawah Settings.

## Home

Home dibuka dengan sapaan dan satu baris tentang apa yang sedang terjadi: berapa agent yang bangun, berapa misi yang
sedang jalan, berapa hal yang butuh kamu. Di pojok sapaan, box-nya bilang apakah semua berjalan baik, versinya, dan
sudah berapa lama nyala, di sebelah badge update dan **Restart**; hal yang perlu dicek tampil sebagai kartu tepat di
bawahnya. Lalu, berurutan:

- **Yang butuh kamu.** Tool call yang ditunggu agent dijawab langsung di situ: **Allow once**, **Deny**, dan **Always
  allow** kalau ditawarkan. Misi yang menunggu jawaban, permintaan untuk bicara dengan agent, skill yang perlu
  ditinjau, fakta yang ingin disimpan atau diubah oleh proses malam, atau dokumen yang disimpan agent untuk sebuah
  koleksi tampil sebagai kartu yang membuka halamannya. Fakta dan dokumen ditampilkan ke yang boleh memutuskannya:
  admin atau operator.
- **Yang sedang jalan.** Tiap misi yang sedang dikerjakan, dengan seberapa jauh checklist-nya.
- **Quick chat**, di laptop: satu baris ke sebuah agent, orchestrator lebih dulu dan diberi tanda, lalu chat-nya
  terbuka dengan jawabannya. Di HP, tombol **+ Chat** melayang di atas bar tab sebagai gantinya.
- **Your agents.** Office versi kecil, dan di sebelahnya tiap agent sebagai chip: kucingnya, namanya, mahkota di
  orchestrator, dan titik untuk apa yang sedang ia kerjakan. Chip membuka agent-nya; gambarnya membuka Office.
- Lalu pemakaian AI hari ini, dilipat jadi satu baris, dan catatan setup kalau saat terakhir dinyalakan ada yang
  ditemukan.

Kalau gak ada yang menunggu dan gak ada yang jalan, kucingnya bilang *Nothing is waiting for you*: lagi tidur, lagi
ngopi, atau bersandar di skuternya, gambarnya beda tiap kali kamu buka Home. Selama ada misi yang jalan, ia naik skuter
di sebelah daftarnya.

## Tanya orchestrator dari halaman mana pun

Kebanyakan halaman punya tombol di header-nya, **Ask** dan nama orchestrator-mu: *Ask Nouva to create an agent* di
Agents, *to set up a webhook* di Webhooks, *to schedule something* di Schedule, *to add a model* di Models, dan
seterusnya. Tombol itu membuka chat dengan orchestrator, dengan permintaan untuk halaman itu sudah tertulis dan bagian
kosong (…) untuk yang kamu mau. Lengkapi lalu kirim: tidak ada yang terkirim sebelum kamu menekan kirim, dan agent
tetap minta izin untuk hal yang berisiko. Tombolnya ada untuk yang boleh chat (admin atau operator), dan hanya kalau
orchestrator sudah dipilih. Di HP tulisannya **Ask Nouva**.

## Agent adalah modulnya

Ini satu keputusan struktural yang layak dijelaskan. Semua tentang satu agent, file, model, bot, siapa
yang boleh menjangkaunya, apa yang dibawanya, ada di bawah agent itu, bukan tersebar di empat halaman
tingkat atas yang harus kamu gabungkan sendiri.

Itu juga menutup satu kegagalan. Koneksi dibuat dari halaman agent itu sendiri, jadi formulirnya gak
perlu menanyakan kepemilikan dan dashboard gak bisa membuat gateway yang gak dimiliki siapa pun. Gateway
yang ditulis manual di `config.toml` tanpa pemilik ditandai di bagian atas halaman Agents.

![Daftar agent](/media/dashboard-agents.png)

### Model versus Models

Perbedaan yang nyata, bukan kebetulan penamaan. **Profil** adalah infrastruktur, endpoint, wire
format, kredensial, didefinisikan sekali di *Models* lalu dipakai bersama. **Model** adalah pilihan
satu agent di dalamnya, di tab *Model* milik agent itu. Memisahkan keduanya adalah yang membuat satu
agent bisa pindah deployment tanpa menyentuh yang lain.

Tab *Model* juga mengatur seberapa lama model agent berpikir (**Effort**), yang diminta di setiap request-nya di semua
chat; `/effort` di sebuah chat memasang level chat itu sendiri di atasnya, dan `/effort <level> lock` dari admin di
sebuah chat mengatur yang ini.

[Agent eksternal](/id/docs/manual/external-agents/) punya tab **Brain** sebagai ganti *Model*: CLI coding yang
menjawabnya, akun, preset, dan model CLI-nya, dengan model Nouride sendiri untuknya terlipat di bawah. Akun-akunnya ada
di *Models → Coding CLIs*.

![Tab Model milik sebuah agent](/media/dashboard-agent-model.png)

### Files

Persona pack, diedit di browser. File Markdown terbuka di pratinjaunya, dengan **Edit** di sebelahnya, dan
keduanya setinggi yang sama dan di-scroll di dalamnya, jadi pindah di antara keduanya gak menggeser halaman.

![Tab Files milik sebuah agent](/media/dashboard-agent-files.png)

Pratinjaunya membangun elemen React dan gak ada rendering HTML mentah di mana pun dalam aplikasi ini.
Agent bisa menulis `MEMORY.md`-nya sendiri dan membuat skill-nya sendiri; merender itu sebagai HTML
akan mengubah "model menuliskan tag script" menjadi script yang berjalan di browser admin, same-origin,
dengan cookie sesi.

`config.toml` di sini milik agent itu sendiri. Milik daemon ada di kartu terakhir
**Agents → Settings**.

### Settings, untuk semua agent

**Agents → Settings** memuat yang berlaku untuk semua agent: boleh atau gak pengirim baru minta masuk,
group context, path kredensial, mention antar agent, batas biaya harian, batas tool dan turn, berapa
lama percakapan disimpan, dan `config.toml` milik daemon untuk apa pun yang belum punya form. Tab
*Settings* milik satu agent hanya memuat apa yang ditimpa agent itu.

![Agents → Settings: siapa yang boleh minta masuk, dan seberapa banyak isi grup yang diikuti agent](/media/dashboard-agents-settings.png)

## Yang menunggu kamu, dan di mana

Empat hal menunggu keputusan orang, dan masing-masing punya tempatnya sendiri. Mencampurkan dua yang
pertama pernah memakan waktu satu jam seorang operator, dan pilihan katanya dibuat supaya itu gak
terulang.

| | Di mana | Artinya |
|---|---|---|
| **Approvals** | Home, Work → *Waiting for you*, dan di bawah percakapan di Chats, hanya kalau gak kosong | Agent berhenti di tengah giliran, ingin menjalankan sesuatu |
| **Permintaan pairing** | **Settings → Access** → *Pending*, dengan angka di sebelah Settings di menu | Seseorang meminta izin masuk sama sekali |
| **Skill drafts** | Skills Workshop → *Pending*, dengan angka di sebelah Skills di menu | Agent *mengusulkan* sebuah skill, atau kamu mengambilnya dari hub |
| **Memory proposals** | Home, dan Knowledge & Memory → *Proposals*, dengan angka di sebelah Memory di menu | Proses malam ingin mengubah sesuatu yang sebaiknya diputuskan orang |
| **Dokumen untuk ditambahkan** | Home, dan kartu koleksinya di Knowledge & Memory → *Knowledge*, dengan angka di sebelah Memory | Agent menyimpan dokumen untuk sebuah koleksi, dan dokumen itu menunggu kamu tambahkan atau tolak |

Approval adalah giliran yang berhenti di tengah jalan dengan timer. Draft atau proposal adalah usulan
tentang pekerjaan yang sudah selesai: gak menghalangi apa pun dan menunggu kamu. Menyatukan mereka
dalam satu antrean akan memberi salah satunya siklus hidup yang salah.

### Apa yang Home katakan tentang yang lain

Approval dijawab langsung di Home, paling depan di antara yang butuh kamu, dan di *Waiting for you* milik Work, karena
agent-nya memang terhenti dan jawabannya adalah alasan kenapa ia ditampilkan. Antrean yang gak bisa ditemukan siapa
pun adalah giliran yang akhirnya kedaluwarsa.

Permintaan pairing dan skill draft hanya *diumumkan* di sana, satu kartu masing-masing, berisi berapa
yang menunggu dan membuka tempat ia dijawab:

> 2 people ask to talk to your agents. **See who is asking →**
> A new skill waits for your review. **Review them →**

Keduanya hanya muncul kalau antreannya gak kosong, dan gak satu pun membawa tombol approve. Mengizinkan
orang asing masuk, atau menerbitkan skill yang ditulis agent, bukan keputusan yang diambil dari
halaman yang cuma kamu lirik, jadi jumlahnya di sini, permintaannya dibaca di tempat ia diputuskan.
Misi yang menunggu jawaban juga tampil sebagai kartu, yang membuka misinya. Memory proposals tampil
sebagai angka di tab *Proposals*.

![Kartu approval](/media/dashboard-approvals.png)

## Link dari chat

Saat ditanya soal misi, job terjadwal, atau approval, agent memberimu link ke halamannya di sini, dan notifikasi misi
*mulai*, *butuh kamu*, dan *selesai* juga membawanya. Link dibangun dari `[dashboard] public_url`, alamat dashboard dari
luar. Tanpa itu tidak ada link: alamat `localhost` tidak bisa dibuka dari HP.

- **Di chat pribadi**, link hanya diberikan ke orang yang punya akun dashboard: id `web:<akun>` di entri People-nya.
  Yang lain tetap mendapat jawaban, laporan, dan file yang sama, tanpa link.
- **Di grup**, link tetap ditulis siapa pun yang ada di sana. Orang tanpa akun yang membukanya hanya melihat halaman
  login.
- **Dibuka saat belum masuk**, link membawa ke halaman login, lalu setelah masuk, ke halaman yang dimaksud.
- **Tanpa kartu pratinjau.** Pesan yang berisi link dikirim dengan pratinjau dimatikan, jadi chat tidak menampilkan kartu
  halaman login.
- **Satu job di Schedule.** Link untuk job yang diusulkan agent, `/schedule?job=<id>`, membuka halamannya dengan kartu
  job itu ditandai dan riwayat run-nya terbuka.

## Skills ada di tingkat atas *dan* sebagai tab

Keduanya penting. Sebuah skill gak dimiliki agent, ada satu kumpulan dan semua agent ditawari
seluruhnya, jadi pertanyaan "siapa yang punya ini, dan apakah mesin ini punya `dot` yang dibutuhkan?"
gak punya agent untuk ditempati. Itulah Workshop. Tab agent menjawab arah sebaliknya: apa yang dibawa
*yang satu ini*.

Dua tampilan untuk satu sakelar, itu sebabnya baris di Workshop membawa badge per agent alih-alih
tautan ke lima halaman. *Explore* memasang skill yang ditulis orang lain; ia mendarat di *Pending*
seperti draft lain.

![Skills Workshop](/media/dashboard-skills.png)

Sebuah baris terbuka menjadi `SKILL.md`-nya di tempat, diambil hanya saat dibuka. Memutuskan apakah
sebuah agent perlu membawa sesuatu dan membaca isinya adalah pekerjaan satu layar.

[Skill & pembelajaran →](/id/docs/manual/skills/)

## Knowledge & Memory

Apa yang diketahui dan diingat para agent, khusus operator. **Knowledge** berisi dokumen yang kamu simpan untuk mereka,
dalam koleksi: siapa yang boleh dijawab dari masing-masing, file yang diseret atau ditulis di sana, yang menunggu
persetujuan admin, pencarian di dalamnya, dan dokumen terkait tiap dokumen ([Knowledge base →](/id/docs/manual/knowledge/)).
Tab lainnya memori: catatan milik tiap agent, apa yang diketahui tentang tiap orang (beserta dokumen tentang mereka),
setiap percakapan di timeline, apa yang diketahui semua agent, dan perubahan yang menunggu kamu. **Tidy tags** dan kartu tag di atas tab menjaga kosakata tag tetap ringkas, dan **Graph view**
(`/memories/graph`) menampilkan memori yang sama sebagai bentuk: percakapan yang terhubung ke orang, tag,
dan agent di dalamnya, dan kalau **Documents** dinyalakan, koleksi, dokumennya, link di antaranya, dan dokumen yang
maknanya berdekatan.

[Memori →](/id/docs/architecture/memory/)

## Hal-hal yang selalu dilakukan UI ini

Bukan preferensi gaya, masing-masing adalah bug yang pernah ditulis, atau yang dicegah oleh bentuk
kodenya.

**Aksi destruktif bertanya, dan menyebutkan akibatnya.** Item mana, berapa agent yang terpengaruh, dan
bahwa gak ada yang bisa membatalkannya. Tombolnya memuat kata kerjanya, "Delete", bukan "OK".

**Kredensial bersifat tulis-saja.** Kolom token pada koneksi yang ada selalu kosong, dan kosong berarti
*biarkan*, bukan *hapus*. Gak ada yang membaca kredensial kembali, jadi kolom itu gak pernah memuat
nilai tersimpan untuk dipilih lalu ditimpa orang; placeholder-nya cuma bilang *unchanged*.

**Gateway yang tersimpan bukan gateway yang berjalan.** Adapter dibangun saat boot, jadi koneksi
tersimpan yang belum berjalan menyebutkan perlunya restart dan menyediakan tombolnya.

**Ia menyebutkan keadaan yang benar.** Koneksi yang ada tapi belum pernah start ditampilkan sebagai
"not started", bukan "disconnected", melabelinya disconnected mengirim orang mengejar masalah jaringan
yang gak ada.

**Gak ada yang bisa mengunci instance ini.** Gak ada yang bisa menghapus akunnya sendiri, dan admin
terakhir gak bisa diturunkan, jadi selalu ada yang tersisa untuk mengelola akun.

**Tiap akun adalah seseorang di People.** Membuat akun menanyakan **Who is this?**: seseorang yang sudah ada di People dan
belum punya akun, atau orang baru yang namanya diambil dari akun itu. Akun yang dibuat sebelumnya masing-masing diberi
orangnya sendiri saat Nouride start; tidak ada yang dicocokkan ke orang lewat nama, jadi tautkan ke orang yang benar di
Users kalau ternyata orang yang sudah ada.

## Chat

**Chats** adalah satu daftar di sebelah percakapan yang sedang kamu buka. Di HP, daftarnya tampil dulu, dan percakapan
terbuka memenuhi layar dengan panah untuk kembali ke daftar.

Daftarnya punya dua bagian, dipilih di atasnya:

- **Chats** berisi semua yang bisa kamu ajak bicara dari dashboard. Orchestrator kamu selalu paling atas. Sesudahnya
  agent dan room yang pernah kamu ajak bicara, yang terbaru di atas, masing-masing dengan kucingnya, pesan terakhir, dan
  jamnya. **Working** tampil selagi agent bekerja, plus berapa helper yang sedang jalan, dan titik menandai balasan yang
  belum kamu baca. Agent yang belum pernah kamu ajak bicara menunggu di bawah, di **Not talked to yet**.
- **Groups** berisi grup tempat agent kamu ada di Telegram, Discord, dan WhatsApp, satu baris per grup meski beberapa
  bot agent kamu ada di grup yang sama, masing-masing dengan nama aplikasinya dalam warna aplikasi itu (WhatsApp hijau,
  Telegram biru, Discord nila), dan room yang kamu buat di dashboard. Chip per aplikasi menyaring daftarnya,
  **Dashboard** menyaring ke room kamu, dan yang diam dua minggu atau lebih dilipat jadi satu baris di bawah. Titik di
  **Groups** artinya ada grup yang ramai sejak terakhir kamu lihat.

Tombol **+** di atas memulai chat dengan agent atau membuat room, dan kolom cari menemukan chat dari namanya atau pesan
terakhirnya.

**Chat kamu milik kamu.** Tiap akun melihat miliknya sendiri: percakapannya dengan tiap agent di sini, chat pribadinya
dengan agent di Telegram, Discord, dan WhatsApp (lewat orang yang jadi akun itu di People), grup tempat orang itu pernah
bicara, dan room yang ia buat atau pernah bicara di dalamnya. Dua akun yang bicara dengan agent yang sama masing-masing
punya percakapan sendiri. Operator atau viewer tidak pernah melihat milik orang lain: tidak di daftar, tidak juga lewat
link-nya. Admin memilih **Mine** atau **Everyone** di atas daftar dan di History: **Everyone** menampilkan semua
percakapan dipisah per orang, lalu yang dikatakan jadwal sendirian, lalu chat pribadi orang yang belum ada di People
(**Not known**). Kolom di bawahnya menyaring daftar ke satu orang: ketik sebagian namanya lalu pilih, atau pilih **Not
known**. Percakapan jadwal dan mission belum dipisah per orang: semua orang tetap melihatnya seperti sebelumnya.

**Chat dengan agent** membuka percakapan terakhirnya, jadi kamu lanjut dari yang tadi. **History** di header-nya hanya
berisi percakapan agent itu: yang di dashboard, dan chat pribadinya di aplikasi chat, masing-masing dengan asalnya.
**New chat** memulai yang baru. Untuk menghapus percakapan, pakai menu (**…**) di barisnya di History, atau menu chat
itu sendiri saat sedang dibuka; kamu ditanya dulu, dan gak ada yang bisa membatalkannya.

**Room** adalah satu percakapan dengan beberapa agent. Pilih agent-nya waktu membuat room, lalu tag yang kamu maksud
(`@nox`): tag adalah cara sebuah pesan sampai ke agent tertentu. Header room menampilkan anggotanya sebagai tag yang kamu
ketik, dan bilang siapa yang menjawab pesan tanpa tag, kalau memang ada: orchestrator kalau ia ada di room itu, atau
satu-satunya agent di room itu. Setelan yang membuat grup di aplikasi chat menunggu tag gak berlaku di sini; `/mention on`
di room itu yang berlaku. **Add agent** memasukkan agent lain; menu room untuk mengganti nama, mengeluarkan agent, atau
menghapus room.

**Semua yang dari aplikasi chat hanya bisa dibaca di sini.** Grup, atau chat pribadi dengan agent di Telegram, Discord,
atau WhatsApp, menampilkan nama aplikasinya dan **Read-only**, dan di tempat kotak ketik ada catatan: balasnya di
aplikasinya sendiri. Orang-orang di sana tampil di kiri, masing-masing dengan namanya (nama di People, kalau tidak ada,
nama dari aplikasinya), dan grup menampilkan pesan orang meski tidak ada agent yang menjawab. **Pin to Chats** menyimpan
grup yang sering kamu baca di Chats, di browser ini.

![Chats: daftar di samping percakapan, jawaban dengan langkahnya terbuka](/media/dashboard-chat.png)

Selagi agent bekerja, langkah-langkahnya dilipat jadi satu baris: apa yang sedang ia kerjakan, sudah berapa langkah, dan
berapa lama. Tekan barisnya untuk membuka langkah-langkah terbaru, dengan durasi tiap langkah dan reasoning model; yang
lebih awal tinggal satu tekan lagi. Tekan barisnya lagi untuk melipatnya. Begitu gilirannya selesai, langkahnya tetap
bisa dibaca di bawah jawabannya. Ini cara tercepat melihat *mengapa* sebuah jawaban berbentuk seperti itu.

Gilirannya tinggal di Nouride, bukan di browser, jadi reload atau tab kedua tetap melihat giliran yang masih jalan.
Approval menunggu di bawah percakapan, background job tampil selama jalan, dan mengetik `/` menampilkan perintah slash.
`/stop` dan `/approve` langsung bertindak, gak menunggu di belakang giliran yang mau dihentikan atau dijawabnya. Di chat
satu lawan satu, **Send** tetap ada di sebelah **Stop** selagi agent bekerja: yang kamu kirim saat itu dibaca giliran
yang sedang jalan di langkah berikutnya.

Di atas kotak ketik, plan agent untuk percakapan itu tampil selagi ia bekerja: berapa langkah yang sudah
selesai dan langkah yang sedang dikerjakan, dengan daftar lengkapnya sekali tekan. Mission yang dimulai
dari percakapan itu tampil di sebelahnya, masing-masing dengan progresnya atau apa yang ia butuhkan dari
kamu, dan membuka halamannya sendiri. Plan-nya dipegang agent; baris itu hanya membacanya, dan hilang
begitu plan-nya selesai.
[Mengobrol dengan agent →](/id/docs/manual/chatting/)
