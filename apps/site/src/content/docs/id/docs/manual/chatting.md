---
title: Mengobrol dengan agent
description: Perintah slash, sesi, grup, restart, dan membuat dua agent bekerja sama.
---

Di mana pun kamu bicara dengannya, Telegram, Discord, WhatsApp, dashboard atau `nouride chat`:
pesannya melewati jalur yang sama. Hanya gateway-nya yang berbeda.

## Perintah slash

Ketik ini alih-alih pesan biasa. Yang menjawab adalah daemon, bukan model, jadi gratis dan selalu
jalan. Semuanya dijawab saat itu juga, bahkan ketika sebuah giliran sedang jalan: `/stop` atau
`/approve` gak menunggu di belakang giliran yang justru mau dihentikan atau dijawabnya.

| | |
|---|---|
| `/help` | Daftar perintah yang tersedia |
| `/status` | Model, uptime, dan ukuran konteks |
| `/new` | Mulai percakapan baru |
| `/compact` | Ringkas percakapan sejauh ini, giliran terbaru tetap utuh |
| `/reset` | Reset keras: bersihkan percakapan, kedaluwarsakan approval, muat ulang config |
| `/stop` | Hentikan yang sedang dikerjakan agent ini, lalu tidurkan |
| `/sleep` | Tidurkan agent ini: ia gak menerima kerjaan sampai `/wake` |
| `/wake` | Bangunkan agent ini (`/start` juga bisa) |
| `/mission` | Mulai kerjaan panjang yang ia selesaikan sendiri, atau lihat misi di sini. [Misi →](/id/docs/manual/missions/) |
| `/model` | Ganti model untuk chat ini |
| `/effort` | Seberapa lama model berpikir, untuk chat ini; `/effort <level> lock` untuk semua chat dan misi |
| `/btw` | Tanya sesuatu di samping pekerjaan: agent menjawab sebagai dirinya sendiri, tidak melakukan apa pun, dan tidak masuk ke percakapan |
| `/agents` | Daftar agent |
| `/prompt` | Tampilkan system prompt yang sedang dipakai agent ini (cuma di DM: isinya memuat memorinya) |
| `/reload` | Muat ulang file persona dan config dari disk |
| `/approvals` | Seberapa banyak kamu ditanya sebelum tool jalan (`careful` atau `balanced`); mengikuti kamu, bukan chat-nya |
| `/approve` | Setujui satu tool call; tambahkan `always` supaya berhenti ditanya, atau `all` untuk semua yang menunggu |
| `/deny` | Tolak satu tool call |
| `/grants` | Daftar izin permanen, atau cabut: `/grants revoke <id\|all>` |
| `/drafts` | Skill yang diusulkan agent dan menunggu keputusan kamu, `show`, `approve`, `deny` |
| `/secret` | Kata sandi dan kunci yang dikirim di chat ini: apa yang dipegang, `undo`, `set <nama> <nilai>`, `guard off`. Lihat [di bawah](#mengirim-kata-sandi-atau-kunci) |
| `/mention` | Siapa yang menjawab pesan di grup ini yang gak men-tag siapa pun; `<agent>`, `required`, atau `default` untuk mengubahnya (admin). Lihat [di bawah](#grup) |
| `/daemon-restart` | Restart seluruh daemon setelah tidak ada yang berjalan, atau `now`; chat ini dikabari begitu daemon kembali |
| `/commands` | Sinkronkan daftar ini ke menu perintah bawaan platform |

`/commands` layak dijalankan sekali per bot Telegram: ia mendorong daftarnya ke menu asli, supaya orang
yang memakainya gak perlu tahu semua ini. Di dashboard, mengetik `/` menampilkan daftarnya.

`/daemon-restart` dipakai untuk perubahan yang butuh restart, misalnya edit `config.toml`. Ia menunggu
sampai tidak ada giliran atau approval yang berjalan, paling lama sepuluh menit, dan sampai setiap
background job selesai, berapa lama pun itu: balasannya menyebutkan job yang ditunggu, dan
`/daemon-restart now` menghentikannya lalu langsung restart. Setelah itu chat-nya menerima
"✓ Restarted, I'm back." Dari chat, hanya admin yang bisa memakainya: orang yang sudah di-pair
dengan bot atau ada di allowlist, dan person-nya di **People** tertaut ke akun dashboard dengan role
admin. Di menu Telegram ia tampil sebagai `/daemon_restart`, karena nama perintah Telegram tidak
boleh memakai tanda hubung. Kedua ejaan sama-sama jalan.

`/effort high` mengatur seberapa lama model berpikir di chat ini, mulai pesan berikutnya, di atas `[llm] effort` milik
agent. Agent yang dijawab model-nya sendiri mengirim level itu di setiap request. Model yang menolaknya ditanya ulang
tanpa level itu, dan jawabannya ditutup satu baris yang menyebutkannya, sekali saja; `/effort` tanpa argumen juga
menyebutnya. Model yang menerima level tapi mengabaikannya tidak bisa dibedakan dari yang mematuhinya, jadi yang
disebut Nouride adalah apa yang ia kirim. `/effort default` mengembalikan level milik agent, yang dipilih di tab Model-nya. Claude Code dan Codex
memasangnya di sesi mereka sendiri: [Agent eksternal →](/id/docs/manual/external-agents/)

`/model` dan `/effort` sebuah chat tetap ada setelah restart, termasuk restart karena update, sampai
`/model default`, `/effort default`, `/reset` atau rollover menghapusnya; `/new` mempertahankannya.

**Di dashboard, dua perintah itu ada tombolnya** (sejak 0.8.35). Di bar atas percakapan dengan satu agent, tombol
bertuliskan nama model membuka panel: pilih model dari daftar atau ketik namanya, dan pilih effort. Ini pilihan yang
sama dengan yang dibuat perintahnya, hanya untuk percakapan itu dan mulai pesan berikutnya, dan masing-masing membaca
apa yang dipasang yang lain. **Back to the agent's own** membatalkannya. Model yang dipilih sebelum pesan pertama
sebuah percakapan ikut terkirim bersama pesan itu. Agent yang dijawab coding CLI memilih di antara model yang
ditawarkan CLI-nya, setelah CLI itu menyebutkannya. Room dan chat di aplikasi chat tetap memakai perintahnya.

Level sebuah chat hanya berlaku di chat itu, dan misi berjalan di percakapannya sendiri. `/effort max lock` menjadikan
level itu milik agent: ditulis ke config-nya seperti yang dilakukan tab Model, untuk semua chat dan semua misi, dan tetap
ada setelah restart. `/effort lock` mengunci level yang dipasang chat ini, dan `/effort unlock` menghapus level milik
agent. Hanya admin yang bisa, yaitu orang yang di **People** terhubung ke akun dashboard admin, sama seperti
`/daemon-restart`.

`/btw port-nya tadi berapa?` mengajukan pertanyaan sampingan, saat agent sedang bekerja atau tidak. Agent menjawab
sebagai dirinya sendiri, dalam bahasa Anda, dari percakapan sejauh ini dan pekerjaan yang sedang berjalan, di modelnya
sendiri dengan berpikir singkat, dalam satu menit. Dari sana ia tidak melakukan apa pun: tanpa alat, tidak ada yang
dijalankan atau diubah. Minta ia mengerjakan sesuatu, dan ia bilang dengan kata-katanya sendiri bahwa itu lebih baik
disampaikan di chat utama, tempat ia bisa mengerjakannya. Jawabannya diawali `btw:` dan tidak masuk ke percakapan:
pekerjaan berjalan seperti semula, dan pesan berikutnya dijawab seolah pertanyaan itu tidak pernah ada. Dashboard
menampilkannya di samping giliran. Satu per chat dalam satu waktu.

## Sesi, dan apa yang sebenarnya dibersihkan `/new`

Percakapan disimpan per agent per chat. `/new` memulai yang baru, agent berhenti melihat pesan-pesan
sebelumnya. Gak ada yang memulai percakapan baru otomatis kecuali kamu set `[rollover] mode` ke
`daily` atau `idle`; default-nya mati.

Yang selamat dari `/new`:

- **`MEMORY.md`**: catatan kurasi milik agent sendiri.
- **People**: siapa kamu, dipanggil apa, dan apa yang ditulis operator tentang kamu.
- **Skill**: kumpulan bersama.
- **Memori**, kalau menyala: percakapan yang dibersihkan `/new` tetap disimpan dan diarsipkan malam
  harinya, jadi yang penting darinya bisa muncul lagi nanti. [Memori →](/id/docs/architecture/memory/)

Jadi solusi untuk "dia lupa nama adikku setelah `/new`" bukanlah menghindari `/new`. Solusinya adalah
menuliskan fakta itu di salah satu tempat di atas, di mana ia permanen.

## Ketika percakapan jadi panjang

Daemon melakukan pemadatan, bukan pemotongan: bagian lama percakapan diringkas dan giliran terbaru
disimpan apa adanya. Itu terjadi otomatis, dan `/compact` memaksanya lebih awal.

Sebelum itu, apa yang dicetak sebuah tool lebih dari dua giliran lalu keluar dari percakapan (sejak 0.8.13): setiap
hasilnya diganti satu baris yang menyebut di mana teks lengkapnya disimpan, yang dibuka agent dengan `read` bila perlu
lagi. Ini terjadi saat cache model untuk percakapan itu memang sudah hilang (prompt, model atau tool agent berubah,
atau chat diam satu jam), atau saat jumlahnya cukup besar untuk layak ditulis ulang, jadi chat yang sedang aktif
tetap kena cache.

Satu tugas yang panjang dijaga dengan cara yang sama (sejak 0.8.35). Kalau satu giliran sudah mengambil begitu banyak
langkah sampai langkah-langkah itu sendiri memenuhi konteks model, agent merangkum langkah-langkah awalnya dan lanjut
dari catatan itu. Sebelumnya giliran seperti itu berhenti di situ, dengan pekerjaan yang belum selesai.

`max_context_ratio` menentukan seberapa banyak jendela konteks model diisi sebelum itu berjalan.
[Referensi konfigurasi →](/id/docs/reference/config/)

## Mengirim pesan selagi ia bekerja

Di chat satu lawan satu kamu gak perlu menunggu giliran selesai. Kirim pesan selagi agent bekerja dan
giliran itu membacanya di langkah berikutnya. Gak pernah di tengah langkah: apa pun yang sedang jalan,
sebuah tool atau panggilan model, selesai dulu, lalu pesan kamu ditaruh di depan model sebelum
panggilan berikutnya. Agent tahu ini bisa terjadi, jadi "pakai database staging" atau "berhenti di
situ" mengubah apa yang sedang dikerjakannya, bukan menunggu di belakangnya. Kamu langsung dikabari:

> ↪ Got it, I'll read that before my next step.

Sedetik dua detik kemudian agent menambahkan satu kalimat dari dirinya sendiri, dalam bahasa kamu,
tentang apa yang akan ia lakukan dengan pesan itu, seperti rekan kerja yang menjawab tanpa berhenti
bekerja:

> Siap, abis command ini selesai gw pindah ke database staging.

Kalimat itu cuma satu panggilan model kecil. Isinya persona agent, supaya gayanya tetap gayanya
sendiri, notes kamu di People, supaya kamu dipanggil sesuai keinginanmu, bagian terakhir percakapan,
supaya "yang itu" di pesanmu berarti sama seperti maksudmu, lalu permintaan yang sedang dikerjakan
giliran itu, beberapa langkah terakhirnya dan pesan kamu. Giliran itu diberi tahu apa yang sudah ia
katakan sebagai tebakan cepat, dan mengikuti kata-katamu kalau tebakannya salah tangkap.

Kalau giliran itu lebih cepat dari kalimatnya, membaca pesan kamu, menjawab atau selesai sebelum
kalimatnya siap, panggilannya dihentikan dan gak ada lagi yang dikirim: yang dilakukan giliran itu
dengan pesan kamu itulah jawabannya. Sama halnya kalau panggilannya gagal atau lebih lama dari
`steer_reply_timeout_ms` (15 detik). Selama satu kalimat sedang ditulis, pesan berikutnya cuma dapat
"Got it".

`[queue] steer_reply = false` tetap mengirim "Got it" tanpa kalimat itu. `steer_reply_model` memilih
model yang lebih cepat di provider agent untuk kalimat itu: model reasoning bisa butuh sepuluh detik
untuk satu kalimat.

Kalau giliran itu sedang menunggu approval di chat tersebut, balasannya bilang pesan kamu dibaca
begitu approval-nya dijawab, dengan `/approve` atau `/deny` (di room, cara menjawabnya diserahkan ke
pesan approval itu sendiri). "Iya" yang diketik sebagai pesan gak menjawabnya.

- **Beberapa pesan** yang dikirim sebelum langkah berikutnya dibaca bersama, sebagai satu. Satu
  giliran membaca lima dengan cara ini; setelah itu, pesan menunggu gilirannya selesai, dan kamu diberi
  tahu sekali: "⏳ Nouva is still working on "…": this message waits for it, and is answered next."
- **Giliran yang sudah menulis jawaban akhirnya** gak punya langkah berikutnya. Pesan kamu gak hilang:
  ia memulai giliran berikutnya begitu giliran ini selesai. Kalau daemon mati duluan, restart-nya yang
  menjawab; setelah `/stop`, ia diperlakukan seperti pesan apa pun ke agent yang dijeda.
- **Cuma kata-kata yang dibaca begini.** File atau gambar menunggu gilirannya, dan perintah slash
  dijawab saat itu juga, seperti biasa.
- **Agent yang dijawab Claude Code atau Codex** (sejak 0.8.10) menerima pesan kamu di tengah prompt yang
  sedang jalan, lewat CLI-nya. Kalau ada perintahnya yang lagi jalan, pesannya nunggu perintah itu selesai,
  paling lama lima menit, supaya test yang lagi jalan gak tergeser; setelah itu CLI-nya berhenti dari apa
  yang sedang ditulisnya untuk membacanya. CLI yang gak bisa menerima pesan di tengah prompt membacanya
  begitu prompt-nya selesai, dan "Got it"-nya bilang begitu: "I'll read that once what I'm running now ends."

Apa yang dibaca giliran itu tetap ada di percakapan. Di dashboard pesan kamu langsung muncul di bawah
langkah-langkah agent, dengan "Got it" dan kalimat dari agent di bawahnya, dan langkah-langkahnya
menandai kapan giliran itu membacanya: `read a message sent while working: "…"`. Di room pesan kamu
tetap di tempatnya sendiri, dan kartu agent mengutipnya di atas kalimat yang menjawabnya.
`[queue] steer = false` mematikannya, dan pesan yang dikirim di tengah giliran lalu menunggu gilirannya.

### Di room

Orang yang memulai giliran itu bisa mengarahkannya dengan cara yang sama, asal pesannya memang untuk
agent tersebut: menyebut namanya (`@nouva …`, `nouva: …`) atau membalas sesuatu yang ia katakan.
Orang lain yang menyapa agent yang sedang sibuk dapat jawaban singkat, bukan diam, sekali per giliran:

> ⏳ Nouva is still working on "migrate the database" (4m so far): ask again once it's done.

Yang dikutip adalah permintaan yang sedang dikerjakan giliran itu, satu baris dan tanpa `@`, jadi
balasannya gak membangunkan siapa pun. Ia menyebut kalau giliran itu sedang menunggu approval, dan gak
pernah menyarankan `/stop`, yang menjeda agent di semua chat. Pesan yang gak menyapa agent, orang-orang
yang ngobrol sendiri di room dengan satu bot, gak dapat apa-apa, seperti sebelumnya.

Agent lain yang menyerahkan pekerjaan ke agent yang sibuk juga gak pernah mengarahkannya, tapi serah
terimanya disimpan (0.8.33). Room dikabari sekali:

> ⏳ Nox is still working on "deploy the shop" (4m so far): this message waits for it, and is answered next.

Begitu giliran itu selesai, agent yang tadi sibuk mengambil serah terima itu sebagai giliran
berikutnya. Serah terima kedua dari agent yang sama digabung ke yang pertama, jadi dua-duanya
dikerjakan dalam satu giliran. Yang menunggu lebih lama dari batas tunggu pesan di antrean
(`queue_timeout_ms`, satu jam secara default) ditinggal, dan agent yang dituju mengatakannya di room.

## Mengedit pesan yang sudah kamu kirim

Di Telegram, Discord dan WhatsApp sebuah edit sampai ke agent, dan posisi pesan kamu menentukan apa yang
terjadi:

- **Belum dijawab** (masih menunggu gilirannya): agent menjawabnya sesuai koreksimu, sekali.
- **Sedang dijawab** (giliran itu sedang mengerjakannya): edit-nya sampai ke giliran itu di langkah
  berikutnya, seperti pesan yang dikirim selagi ia bekerja, sebagai koreksimu. Kamu dikabari
  "↪ Got your edit, I'll go by it from my next step."
- **Sudah dijawab**: agent ditanya lagi, diberi tahu bahwa itu edit dan apa isi pesan sebelumnya, supaya
  ia bisa bilang apa yang berubah. Cuma untuk edit dalam lima belas menit sejak pesan itu dikirim,
  seperempat jam yang sama setelah mana sebuah pesan terlalu lama untuk dijawab sama sekali: typo yang
  dirapikan di pesan lama gak memulai apa-apa.

Edit yang gak mengubah apa pun yang terlihat juga gak memulai apa-apa (Telegram dan Discord mengirim
ulang pesan ketika preview link-nya termuat), dan edit yang sekarang berbunyi perintah gak dijalankan:
kirim perintahnya sebagai pesan tersendiri. Di room, edit diarahkan seperti pesan apa pun: yang sekarang
menyebut agent sampai ke agent itu, dan yang gak menyebut siapa pun cuma mengubah apa yang didengar
para agent. Edit itu kata-kata: gambar yang diganti lewat edit gak dikirim ulang ke agent.

Balasan agent untuk sebuah edit mengutip pesan kamu. Di chat dashboard, pesan yang dijawab sebagai edit
diberi tanda kecil *edited* di bawahnya, begitu juga pesan yang diedit selagi giliran bekerja. `nouride turns`
menandai gilirannya `edited`, `nouride turns show` menyebut pesan yang mana, dan `nouride events` menutup
barisnya dengan `(edited)`; di stream tercatat sebagai `editOf`.

## Mengirim kata sandi atau kunci

Tempel kredensial ke chat dan daemon mengambilnya dari pesan kamu sebelum apa pun menyimpannya atau
model membacanya. Sebagai gantinya agent melihat sebuah handle, `$TMP_SECRET_` dan dua belas karakter,
dan daemon langsung mengabari kamu, di chat dan di dashboard:

> 🔒 Taken out of your message before anything stored or read it: a GitHub token ($TMP_SECRET_3F9A1C2B7D4E).
> The agent can use it in commands for an hour without seeing it.

Yang dikenali: format layanan yang paling banyak dipakai (penyedia model, Nougate, GitHub dan GitLab,
token bot Telegram dan Discord, cloud, Stripe, Midtrans dan Xendit, private key, web token, kata sandi
di dalam URL), dan nilai yang kamu berikan ke key yang bernama rahasia: `password: …`, `TOKEN=…`,
`"api_key": "…"`, `kata sandi: …`. Kata biasa, nama, path, atau potongan kode di situ tetap seperti yang
kamu tulis. Kata sandi yang ditulis di dalam kalimat tanpa `:` atau `=` tidak dicari (cara orang
menyebutnya tak terbatas), jadi kirim sebagai `password: …`, atau simpan dengan `/secret set`. Yang kamu
kutip juga dihitung: balasan ke pesan yang memuatnya ikut diambil dari kutipannya.

Agent memakai handle itu di dalam perintah, `curl -H "Authorization: Bearer $TMP_SECRET_…"`, dan
perintahnya menemukan nilainya di environment; apa pun yang dicetak perintah itu disamarkan. Nilainya
cuma ada di memori daemon (tidak pernah di riwayat percakapan, dashboard, baris log, atau request ke
model), dan hilang satu jam setelah kamu kirim, atau ketika daemon restart. Supaya tersimpan, minta agent
menyimpannya dengan sebuah nama, atau lakukan sendiri dengan `/secret set`. Agent yang menyimpannya mencatat untuk apa
secret itu di sampingnya (0.8.19): situsnya, username atau email pasangannya, apa yang memakainya. Keterangan itu bukan
rahasia, dan bisa kamu ubah di halaman Secrets dashboard; nilainya sendiri cuma bisa diganti.

Perintah yang mencetak file kredensial atau environment memberi handle yang sama, satu per nilai (lihat
[file kredensial](/id/docs/manual/approvals/#secret-yang-boleh-dipakai-agent-tapi-gak-pernah-dibacanya)), jadi `/secret` bisa
menampilkan `DB_URL in box:/srv/app/.env` di samping yang kamu kirim.

| | |
|---|---|
| `/secret` | Apa yang dipegang chat ini: tiap handle, jenisnya, dan sisa menitnya |
| `/secret undo` | Itu bukan rahasia: pesan terakhirmu kembali seperti yang kamu tulis, sebagai edit dari dirinya sendiri, dalam lima belas menit |
| `/secret set <nama> <nilai>` | Simpan nilai dengan sebuah nama, permanen, dan berikan ke semua perintah agent di chat ini sebagai `$NAMA`; `/secret replace` menimpa yang sudah ada. Nilainya juga diambil dari perintah itu, apa pun bentuknya |

Menyimpan nilai dengan nama hanya untuk admin, sama seperti `/daemon-restart`. [Secret guard](/id/docs/manual/approvals/#secret-guard) gak punya saklar sejak 0.8.0.
Platform kamu masih memegang pesan seperti yang kamu kirim, jadi hapus di sana kalau itu penting buatmu;
salinan milik Nouride tidak pernah memuatnya.

## Ketika daemon restart di tengah giliran

Setiap langkah giliran disimpan saat itu juga: pesan kamu, setiap balasan model, setiap hasil tool.
Kalau daemon berhenti di tengah jalan, karena update, crash, atau listrik mati, gak ada yang hilang dari
kerja giliran itu, dan agent memberi tahu sampai mana ia tadi:

> ⚠️ I was interrupted by a restart while working on "deploy the site". Done: `read site.toml`,
> `git status`. Cut off: `exec ./deploy.sh` (it may have partly run). Everything I did is kept. If
> I'm back within 15 minutes I'll carry on by myself; after that I'll ask you first.

Kalau daemon kembali dalam 15 menit, agent melanjutkan sendiri dengan semua yang sudah dimilikinya.
Tool yang terpotong ditandai begitu, jadi agent mengecek dulu apa yang sudah dikerjakan tool itu
sebelum mengulang apa pun yang mengubah sesuatu. Kalau giliran itu terpotong sebelum mengerjakan apa
pun, agent bilang begitu dan menjawab pesan kamu setelah daemon kembali.

Ia melanjutkan sekali saja. Giliran yang justru sedang melanjutkan kerja yang terpotong gak
dilanjutkan lagi, jadi giliran yang bikin daemon crash gak bisa berputar terus, dan run terjadwal
gak dilanjutkan sama sekali.

Kalau daemon baru kembali lebih dari 15 menit kemudian, gak ada yang jalan sendiri: perintah yang
dijalankan sejam terlambat bisa jadi sudah bukan yang kamu mau. Sebagai gantinya agent bertanya ke
kamu, sekali, di chat tempat kerja itu berlangsung:

> I was cut off 1 hour ago while working on "deploy the site". I have not carried on by myself,
> since it was a while ago. Say "continue" and I will pick it up.

Bilang "continue" dan ia melanjutkan dari yang sudah disimpannya. Di Telegram dan Discord
pertanyaannya punya tombol **Continue** yang melakukan hal yang sama; di grup, yang menekannya orang
yang meminta kerja itu atau admin. Setelah listrik mati atau crash, gak ada yang bisa disampaikan
saat itu, jadi pertanyaannya datang bersama daftar apa yang sudah selesai dan apa yang terpotong.
Pertanyaan itu gak diajukan kalau kamu sudah menulis lagi di chat itu, kalau kerjanya run terjadwal,
atau kalau terpotongnya sudah lebih dari dua hari. Kalau mau kerjanya benar-benar berhenti, pakai
`/stop`, bukan restart.

Pesan dicatat begitu tiba, jadi pesan yang dikirim selama restart juga gak hilang. Yang dikirim dalam
15 menit terakhir dijawab begitu daemon kembali; yang lebih lama mendapat catatan singkat bahwa pesan
itu masuk saat daemon offline, bukan jawaban telat untuk pertanyaan kemarin. Pesan yang dikirim dua
kali oleh platform dijawab sekali, dan balasan yang terputus di tengah gak dikirim dua kali.

## Grup

Dua pengaturan menentukan perilaku agent di ruangan tempat ia gak sedang diajak bicara langsung:

- **`groups_require_mention`**: mati secara default. Kalau dinyalakan, agent mengabaikan obrolan di grup
  Telegram, Discord, dan WhatsApp yang gak menyebutnya. DM tetap menjawab semuanya, begitu juga room yang
  kamu buat di dashboard, yang ikut anggotanya: pesan tanpa tag dijawab orchestrator kalau ia ada di room
  itu, atau oleh satu-satunya agent di room itu, dan selain itu gak dijawab siapa pun.
- **`group_context_messages`**: 20 secara default. Ketika agent *memang* dipanggil, sekian pesan
  terakhir ikut serta, sehingga `@nouva ini gimana?` tiba bersama percakapan yang ditunjuknya.

Obrolan biasa tetap gak memicu apa pun. Ia diingat, bukan dijawab, dan agent gak mengungkitnya kecuali
kamu tanya.

Di grup, setiap baris yang dibaca agent berbentuk `Nama: …`, termasuk pesan yang men-tag-nya. Orang yang
ada di `[[people]]` disebut dengan namanya di sana, dari akun mana pun ia menulis; orang lain dengan nama
yang ditampilkan platformnya.

Keduanya berlaku untuk seluruh daemon, di `[agents]`, karena keduanya soal ruangan, bukan soal satu
agent; `group_context_messages` juga ada di halaman **Agents → Settings**. Satu koneksi bisa menimpa
keduanya, dan kolom group context di form koneksi menyatakan dengan jelas bahwa ia sebuah penimpaan.

Sebuah grup juga bisa menjawab satu pertanyaan untuk dirinya sendiri, dari dalam grup itu: **pesan di
sini yang gak men-tag siapa pun, siapa yang menjawabnya?**

- `/mention` menjawabnya dalam satu kalimat: apakah tag diperlukan, siapa yang menjawab pesan tanpa tag,
  dan dari mana setelannya (grup ini, gateway, atau daemon; di room yang dibuat di dashboard: aturan room
  itu sendiri, di atas).
- `/mention @NovelistBot` memberikan grup itu ke agent tersebut: tag gak diperlukan, dan ia menjawab
  setiap pesan di sini yang gak men-tag siapa pun. Agent-nya bisa disebut dengan nama bot-nya, id-nya,
  atau namanya (`/mention novelist`), dan di Discord dengan men-tag bot-nya.
- `/mention required`: tag diperlukan, dan pesan yang gak men-tag siapa pun gak dijawab siapa pun.
- `/mention default` menghapus setelan milik grup, jadi gateway dan daemon yang menentukan lagi, atau,
  di room dashboard, anggotanya.

Tag dan reply tetap menang: di grup yang diberikan ke novelis, `@Alice …` atau reply ke ucapan Alice
tetap milik Alice. Setelan ini hanya menentukan pesan yang gak menyebut siapa pun.

Di Telegram, satu topik adalah ruangan sendiri, jadi `/mention @NovelistBot` yang dikirim di dalam satu
topik memberikan topik itu ke novelis, dan topik lain tetap seperti semula.

Setelan milik grup menang atas setelan koneksi dan daemon, dan tetap tersimpan setelah restart. Ia milik
grupnya, bukan milik satu bot: kalau ada beberapa bot kita di grup itu, semuanya membaca setelan yang
sama, dan perintahnya dijawab sekali. Mengubahnya hak admin, sama seperti `/daemon-restart`; orang lain
diberi tahu begitu dan gak ada yang berubah. Di DM perintah ini gak berbuat apa-apa: DM selalu dijawab.
Pilihan yang sama ada di halaman **Groups** di dashboard, satu daftar per grup, dan yang dikatakan satu
tempat terlihat di tempat lainnya.

`/mention@NovelistBot`, cara menu perintah Telegram menulis perintah untuk satu bot, dijawab oleh bot
itu: ia bilang siapa yang menjawab di sini sekarang, dan cara memberikan grup itu kepadanya.

Kalau agent yang disebut sebuah grup kemudian dihapus atau dimatikan, grup itu mengikuti orchestrator
lagi, dan `/mention` mengatakannya.

Di grup yang berisi beberapa bot kita, pesan yang gak menyebut siapa pun gak pernah dijawab oleh setiap
bot: ia dijawab sekali, oleh agent yang disebut grup itu, atau kalau gak ada, oleh orchestrator
([Gateway → Orchestrator adalah meja depan](/id/docs/gateways/overview/#orchestrator-adalah-meja-depan)).

Sampai 0.8.34 kata-katanya `/mention on` dan `/mention off`. Keduanya masih dibaca: `on` sama dengan
`required`, dan `off` berarti tag gak diperlukan tanpa agent yang disebut, yang dijawab orchestrator.

### Nama grup

Ruangan adalah satu chat di satu platform: grup WhatsApp atau Telegram, channel Discord, thread Discord
(ruangan sendiri), atau ruangan yang dibuat di dashboard. Masing-masing punya percakapan sendiri,
setelan `/mention` sendiri, dan memorinya sendiri.

Nama ruangan adalah nama dari platformnya: subject grup WhatsApp, judul grup Telegram, channel Discord
sebagai `#nama`, dan thread dengan namanya sendiri. Agent diberi tahu nama itu, dan nama itulah yang
dipakai `send_message`: "kirim ini ke Keluarga Besar". **Groups**, di samping People di dashboard,
menampilkan semua ruangan tempat agent bicara, beserta agent-nya dan siapa yang bicara di sana; admin
bisa mengganti namanya di situ, dan mengosongkannya mengembalikan nama dari platform. Dua ruangan
dengan nama yang sama gak ditebak: agent diperlihatkan keduanya dan memilih lewat alamatnya.

File grup di memori (`groups/<…>.md`) adalah tempat menyimpan apa yang dipelajari di sana, bukan
namanya. Mengganti nama file itu gak mengganti nama grup.

### Thread

Di thread Discord, jawaban pertama agent di sana tahu pesan yang memulai thread itu: pesan itu datang
di depan pertanyaan, sebagai `[This thread was started from a message in #channel by Nama: …]`.

:::caution
Semua yang diucapkan di sebuah ruangan menjadi konteks bagi agent di dalamnya, termasuk dari pengirim
yang belum kamu pasangkan. Kalau itu masalah, set `group_context_messages = 0`.
:::

**Di Telegram, semua ini gak berlaku sampai privacy mode dimatikan.** BotFather → `/setprivacy` →
Disable, atau jadikan bot admin. Kalau gak, Telegram memang gak mengantarkan pesannya.

## Dua agent dalam satu ruangan

Agent memanggil satu sama lain dengan tag. Nouva menulis `@nox benerin build ini`, Nox melihatnya dan
mengerjakannya. Room di dashboard bekerja dengan cara yang sama: kamu memilih agent-nya saat membuat
room, dan tag adalah cara sebuah pesan sampai ke salah satunya.

**Tag itulah serah terimanya.** Balasan *tanpa* tag gak sampai ke siapa pun, dan begitulah sebuah
pertukaran berakhir dengan wajar. Rem lunak itu bergantung pada model yang memilih untuk gak nge-tag,
jadi ada rem kerasnya juga: hanya sebuah mention yang merutekan pesan dari agent, bukan channel
binding, bukan pemilik gateway, bukan orchestrator, dan setelah `mention_max_hops` serah terima (5
secara default) daemon mengatakannya di chat lalu berhenti mengantarkan. Manusia yang bicara apa pun
mereset hitungannya, karena batas ini ada untuk membatasi obrolan *tanpa pengawasan*. Di aplikasi chat
yang punya tombol (Telegram, Discord), baris itu membawa tombol **Continue** (0.8.33): sekali tekan,
serah terima yang tadi dihentikan diantarkan dan hitungannya mulai lagi.

Kedua agent berbagi direktori kerja (`workspace/shared/`), dan itulah yang membuat serah terima
bermakna: build yang diminta diperbaiki Nox ada di tempat yang benar-benar bisa dibuka Nox.

**Tiap agent diberi tahu apa yang sedang dikerjakan yang lain (0.8.33).** Di room, pesan yang dijawab
sebuah agent menyebut agent lain mana yang sedang bekerja di situ, permintaan apa dan sudah berapa
lama, dan mana yang sedang tidur. Jadi sebelum nge-tag, ia sudah tahu pekerjaannya bakal menunggu. Ia
juga diberi tahu apa lagi yang jalan di box: gilirannya sendiri di chat lain, helper, misi, dan
perintah latar beserta foldernya, paling banyak enam dan sisanya dihitung. Pekerjaan yang diminta
orang lain di chat pribadi disebut tanpa isinya, cuma jenisnya, foldernya, dan lamanya. Ini memberi
tahu agent dan gak mengunci apa pun: menghindari tabrakan tetap keputusan agent.

**Kalau pekerjaan hasil serah terima gagal.** Kalau agent yang menerima pekerjaan gagal atau kehabisan
waktu, baris yang ditinggalkannya membawa tombol **Continue** dan **Hand to** untuk paling banyak tiga
agent lain di room (0.8.33). Continue membuat agent yang sama melanjutkannya. Hand to memberi agent
lain apa yang tadi diminta ke agent pertama. Siapa pun yang boleh bicara dengan agent itu di room
bisa menekannya, sekali, dan baris itu lalu menyebut siapa memilih apa. Tanpa tombol, baris itu
mengatakan hal yang sama dengan kata-kata: bilang "continue", atau tag agent lain.

**Kalau permintaanmu sendiri gagal di room.** Kalau agent sudah mengerjakan sebagian, baris yang ditinggalkannya
bilang begitu dan membawa tombol **Continue** (sejak 0.8.35), jadi kamu gak perlu men-tag-nya lagi. Kamu, atau
admin, bisa menekannya, sekali. Di chat satu lawan satu gak ada tombolnya: bilang "continue" sama pendeknya.

**Di chat satu lawan satu ini gak bekerja begitu, dan memang gak bisa.** Setiap bot punya
percakapan pribadinya sendiri dengan kamu, jadi tag yang ditulis di DM gak sampai ke siapa pun, bot
agent yang di-tag gak pernah melihat pesannya. Di sana agent menyerahkan pekerjaan lewat tool
`ask_agent`: agent yang lain berjalan di belakang percakapan dengan skill dan izinnya sendiri,
progresnya muncul berlabel `[nox]`, dan jawabannya kembali ke agent yang bertanya. Yang sedang kamu ajak
bicara tetap satu-satunya yang berbicara. Kalau agent lain itu butuh lebih dari semenit, yang sedang kamu
ajak bicara bilang ia masih mengerjakannya dan kamu bisa lanjut ngobrol; jawabannya datang sendiri begitu
siap, lengkap dengan keterangan itu soal apa.

Gak ada yang perlu dikonfigurasi. Prompt memberi tahu setiap agent mana dari dua ini yang berlaku di
chat tempatnya berada, dan `mentions_enabled = false` mematikan keduanya. Sakelar itu dan batas hop-nya
ada di **Agents → Settings**.

## File

Kirim file ke agent dan file itu disimpan untuk percakapan tersebut, lalu agent diberi path-nya. File
yang dikirim di satu chat gak bisa dibuka dari chat lain. Gambar dilihat kalau `read_images` menyala,
oleh model milik agent itu sendiri kecuali kamu menyebut yang lebih murah di `[media] image_model`.
Dokumen **gak** dikirim ke model sama sekali: agent membukanya dengan `read` atau sebuah perintah, jadi
sebuah PDF gak berbiaya apa pun sampai agent benar-benar melihatnya. Voice note dikirim ke model hanya
kalau model itu bisa mendengarnya (`read_audio`).

Gambar yang sangat besar, tangkapan layar panjang atau foto langsung dari kamera, dikirim ke model sebagai
salinan yang lebih kecil: gak ada sisi yang lebih dari 2.576 piksel, sebanyak yang dibaca model (0.8.35).
File kamu gak diubah. Nouride membuat salinannya dengan ffmpeg; di mesin yang gak punya ffmpeg gambar itu
gak ikut dikirim, dan agent diberi tahu ukurannya dan bahwa gambarnya terlalu besar, jadi ia bisa minta
yang lebih kecil. Sebelumnya, satu gambar seperti itu bisa membuat semua giliran berikutnya di
percakapannya gagal, karena penyedia model menolak seluruh permintaannya. `[media] max_image_side`
mengatur angkanya, untuk model yang membaca lebih besar.

Agent mengirim file balik dengan `send_file`. Ia gak akan mengirim file kredensial, atau file apa pun
yang memuat nilai salah satu secret agent itu, karena file di platform chat gak bisa disamarkan.

## Dari terminal

```bash
nouride chat            # orchestrator
nouride chat nouva      # panggil satu per nama
```

Pesan lewat gateway `local` sungguhan milik daemon yang sedang jalan, jadi routing, hook, antrean, tool
loop dan penyimpanan sesi berjalan persis seperti untuk platform chat. Perintah slash jalan. Approval
muncul di tempat dan dijawab dengan satu tombol: `y`, `a` untuk selalu, atau `n`.

Ia juga jalan non-interaktif, stdin yang di-pipe terdeteksi, dan approval dicetak alih-alih
ditanyakan, dan begitulah tes end-to-end berbicara dengan daemon.

[Chat lewat terminal →](/id/docs/gateways/cli-chat/)
