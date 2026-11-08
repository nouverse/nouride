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

![Ikhtisar dashboard](/media/dashboard-overview.png)

## Peta

```
Interact
  Chat            satu agent, atau room berisi beberapa, dengan setiap langkah tampil langsung
  Missions        kerjaan panjang yang diselesaikan agent sendiri: yang butuh kamu, yang jalan, yang selesai; Limits

Monitor
  Overview        kesehatan · token dan biaya hari ini · approval yang menunggu kamu · Office versi kecil
  Office          status para agent sebagai kantor kecil berisi kucing
  Schedule        semua job: buat, ubah, jalankan sekarang; filter aktif / dijeda / gagal
  Webhooks        endpoint yang menjalankan job saat dipanggil, bukan saat jam tertentu
  Background Helpers  helper, perintah dan agent yang ditanya, yang dibiarkan agent jalan: langkahnya, Stop
  System Logs     Daemon · Audit · Schedule · Background Helpers

Configure
  Agents          daftarnya, New Agent (admin), dan Settings seluruh daemon
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
  Skills          Skills Workshop: Live · Pending · Explore
  Connectors      server MCP instalasi: Installed · Explore, saklar per agent
  Knowledge & Memory   Knowledge · Agent notes · People · Timeline · Shared · Proposals · Settings, dan graph
  People          nama dan catatan untuk manusia yang mereka ajak bicara
  Groups          ruangan tempat mereka bicara: nama tiap ruangan, agent-nya, siapa yang bicara di sana
  Access          siapa yang boleh bicara dengan agent: Pending · Approved · Denied · Blocked · History
  Models          Model providers: endpoint, wire format, kredensial;     (admin)
                  Coding CLIs: akun tiap CLI dan login-nya
  LLM Gateway     Nougate di dalam daemon: akun, key, pemakaian (Router)  (admin)
  Secrets         kredensial, untuk apa masing-masing, password backup    (admin)

Connect
  Integrations    aplikasi AI lain yang menjangkau memori, satu key per aplikasi (admin)
  Web Search      tempat agent mencari: sumber gratis, Brave, SearXNG, sendiri (admin)

Account
  My Account      username, nama, password
  Users           akun dan peran (edisi Pro)                             (admin)
  My Box          perangkatnya sendiri (hanya Box yang sudah dipasangkan)  (admin)

Learn
  Documentation   situs ini
```

Halaman khusus admin **gak muncul** di sidebar bagi yang gak boleh memakainya, bukan muncul lalu
menolak.

**Update** gak punya entri menu. Versi di bawah logo menampilkan titik kalau ada rilis yang lebih baru,
dan badge di Overview membuka halamannya. Cek, unduh, dan pasang adalah tiga langkah terpisah, karena
cuma yang terakhir yang me-restart daemon, dan itu pun menunggu sampai gak ada yang jalan.
[Update →](/id/docs/deployment/updating/)

**Restart**, di sebelahnya di Overview, me-restart daemon untuk perubahan yang membutuhkannya. Ia
bertanya dulu, menunggu sampai gak ada yang jalan, menawarkan **Restart now** selama menunggu, dan
memberi tahu begitu daemon kembali. Cuma admin atau operator yang melihatnya.

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
| **Approvals** | Overview dan di bawah percakapan di Chat, hanya kalau gak kosong | Agent berhenti di tengah giliran, ingin menjalankan sesuatu |
| **Permintaan pairing** | **Access** → *Pending*, dengan angka di sebelah Access di sidebar | Seseorang meminta izin masuk sama sekali |
| **Skill drafts** | Skills Workshop → *Pending* | Agent *mengusulkan* sebuah skill, atau kamu mengambilnya dari hub |
| **Memory proposals** | Knowledge & Memory → *Proposals* | Proses malam ingin mengubah sesuatu yang sebaiknya diputuskan orang |

Approval adalah giliran yang berhenti di tengah jalan dengan timer. Draft atau proposal adalah usulan
tentang pekerjaan yang sudah selesai: gak menghalangi apa pun dan menunggu kamu. Menyatukan mereka
dalam satu antrean akan memberi salah satunya siklus hidup yang salah.

### Apa yang Overview katakan tentang yang lain

Approval dijawab langsung di Overview, paling atas di bawah pemakaian hari ini, karena agent-nya memang
terhenti dan jawabannya adalah alasan kenapa ia ditampilkan. Antrean yang gak bisa ditemukan siapa pun
adalah giliran yang akhirnya kedaluwarsa.

Permintaan pairing dan skill draft hanya *diumumkan* di sana, satu baris masing-masing, berisi berapa
yang menunggu dan tautan ke tempat ia dijawab:

> You have 2 pending pairing requests. **See details →**
> You have 1 skill waiting for review. **See details →**

Keduanya hanya muncul kalau antreannya gak kosong, dan gak satu pun membawa tombol approve. Mengizinkan
orang asing masuk, atau menerbitkan skill yang ditulis agent, bukan keputusan yang diambil dari
halaman yang cuma kamu lirik, jadi jumlahnya di sini, permintaannya dibaca di tempat ia diputuskan.
Memory proposals tampil sebagai angka di tab *Proposals*.

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

## Chat

Bicara dengan satu agent, atau buat **room** berisi beberapa: pilih agent-nya dulu, lalu tag yang kamu
maksud (`@nox`), karena di room, tag adalah satu-satunya cara sebuah pesan sampai ke agent tertentu.
Langkah setiap giliran terbuka langsung saat agent bekerja, dengan durasi tiap langkah dan reasoning
model, dan tetap bisa dibaca sesudahnya. Ini cara tercepat melihat *mengapa* sebuah jawaban berbentuk
seperti itu.

![Chat dashboard dengan langkah giliran langsung](/media/dashboard-chat.png)

Gilirannya tinggal di daemon, bukan di browser, jadi reload atau tab kedua tetap melihat giliran yang
masih jalan, dan daftar percakapan menandai percakapan mana yang sedang bekerja, dari mana pun ia
dimulai. Approval menunggu di bawah percakapan, background job tampil selama jalan, dan mengetik `/`
menampilkan perintah slash. `/stop` dan `/approve` langsung bertindak, gak menunggu di belakang giliran
yang mau dihentikan atau dijawabnya. Di chat satu lawan satu, **Send** tetap ada di sebelah **Stop**
selagi agent bekerja: yang kamu kirim saat itu dibaca giliran yang sedang jalan di langkah berikutnya.

Di atas kotak ketik, plan agent untuk percakapan itu tampil selagi ia bekerja: berapa langkah yang sudah
selesai dan langkah yang sedang dikerjakan, dengan daftar lengkapnya sekali tekan. Mission yang dimulai
dari percakapan itu tampil di sebelahnya, masing-masing dengan progresnya atau apa yang ia butuhkan dari
kamu, dan membuka halamannya sendiri. Plan-nya dipegang agent; baris itu hanya membacanya, dan hilang
begitu plan-nya selesai.
[Mengobrol dengan agent →](/id/docs/manual/chatting/)
