---
title: Siapa yang boleh bicara
description: Pairing, allowlist, dan memberi agent nama untuk orang-orang yang diajaknya bicara.
---

Bot kamu berada di jaringan publik. Siapa pun yang menemukan username-nya bisa mengirim pesan, jadi
siapa yang boleh mencapai sebuah agent adalah pengaturan sungguhan, bukan renungan belakangan.

## Dua sikap

`[security.access] mode`, berlaku untuk seluruh daemon:

| | |
|---|---|
| **`pair`** (default) | Pengirim asing diberi kode pendek lalu pesannya dibuang. Kamu menyetujui kodenya dan mereka diingat, di disk, permanen. |
| **`allowlist`** | Hanya id yang terdaftar atau sudah disetujui yang lewat. Sisanya dibuang **dalam diam**: tanpa balasan, tanpa error. |

Jalur biasanya: pasang dengan `pair`, lalu pindah ke `allowlist` setelah orang-orang yang kamu inginkan
masuk. Pengirim yang sudah disetujui tetap bisa bicara; sisanya dihentikan di gerbang.

Gak ada instalasi yang membolehkan semua orang masuk. Satu agent bisa: meja depan yang menjawab siapa
pun yang menemukannya, dengan beberapa tool milik Nouride sendiri dan tanpa satu pun tool kamu. Itu
[agent yang terbuka untuk semua orang](#agent-yang-terbuka-untuk-semua-orang), di bawah. Sebelum 0.8.48
ada sikap ketiga, `open`, untuk seluruh instalasi;
[apa yang dilakukan upgrade padanya](#instalasi-yang-dulu-open) juga ada di bawah.

## Menyetujui seseorang

Mereka mengirim pesan ke bot dan mendapat kode, dan balasannya menyebutkan di mana kode itu
disetujui, karena orang yang melakukan pairing biasanya orang yang menjalankan daemon-nya sendiri:

![Pesan pertama ke bot Telegram, dibalas dengan kode pairing dan cara menyetujuinya](/media/pairing-chat.svg)

Di grup, kodenya datang dari bot yang ia tag, sebut namanya, atau reply, dikutip di bawah pesannya. Bot
lain di grup tetap diam dan gak membuka permintaan, dan pesan yang gak menyapa agent mana pun gak
dapat apa-apa.

"Kirim kode itu ke siapa pun yang menjalankan saya" jadi jalan buntu kalau kamu **adalah** orang itu
dan gak ada yang memberi tahu bahwa ada halamannya. Jadi pesannya menyebutkan halaman itu.

**Home memberi tahu bahwa ada, begitu juga menu:** angka di sebelah **Settings**, di setiap halaman,
karena kodenya bisa kedaluwarsa (di sebelah **Access** sebagai gantinya, selagi halaman-halaman milik
Settings tampil). Kartu di Home berisi jumlah yang menunggu dan membuka Access, tanpa tombol. Keduanya
hanya muncul kalau memang ada yang mengantre; angka nol permanen adalah sesuatu yang lama-lama berhenti
kamu lihat.

Pemisahan itu disengaja. Home adalah tempat melirik, dan menyetujui orang asing gak bisa
dibatalkan dengan memalingkan muka, jadi keputusannya diambil di halaman yang menampilkan
permintaannya secara utuh, bukan cuma jumlahnya.

**Access** adalah tempat menjawabnya, untuk semua agent sekaligus: satu orang bisa minta masuk ke dua
bot, dan "siapa yang kita blok?" gak ada hubungannya dengan agent tertentu. Lima tab, mengikuti
perjalanan sebuah permintaan:

| Tab | Isinya |
|---|---|
| **Pending** | Semua permintaan yang menunggu, beserta kodenya dan kapan kedaluwarsa. Admin bisa langsung menyetujuinya, menyetujuinya *sebagai* seseorang (**It's me**, orang yang sudah ada di People, atau orang baru), menolaknya (Deny), atau memblokirnya (Block) |
| **Approved** | Semua yang sudah di-pair, masing-masing dengan Revoke, Block, dan orang di People pemilik akun itu, plus id yang diizinkan config tanpa kode kalau config menyebut seseorang |
| **Denied** | Siapa yang ditolak untuk sementara, berapa lama lagi mereka boleh minta, dan tombol **Reset** |
| **Blocked** | Siapa yang ditolak sampai kamu **Unblock** |
| **History** | Semua permintaan dan semua jawabannya, yang terbaru di atas, beserta siapa yang menjawab |

Filter agent menyaring kelimanya untuk satu agent dan kotak filter menyaring daftar tab yang terbuka, keduanya di
baris tab, yang tetap di atas jendela sementara daftarnya bergulir. Tab **Access** milik tiap agent menghitung
pengirimnya lalu menautkan ke sini, sudah tersaring untuk agent itu. Menyetujui sebagai seseorang
menambahkan id itu ke orangnya, jadi semua agent mengenal namanya sejak pesan berikutnya. Setelah
disetujui, mereka diberi tahu di chat yang mereka pakai.

![Halaman Access dengan satu permintaan menunggu: kodenya, It's me, Approve as…, Approve, Deny dan Block](/media/dashboard-access-pending.png)

### Deny atau block

Dua cara bilang tidak, dan artinya beda:

- **Deny** artinya *tidak, untuk kali ini*. Selama sehari (`deny_cooldown_ms`) pesan mereka diabaikan;
  setelah itu, pesan dari mereka jadi permintaan baru dengan kode baru. **Reset** di tab Denied
  mengakhiri masa tunggu itu saat itu juga, buat "tidak" yang ternyata salah kode.
- **Block** artinya *tidak, sampai ada yang bilang lain*. Diabaikan sampai di-**Unblock**, yang
  membolehkan mereka minta lagi. Unblock gak memasukkan siapa pun. Block juga mengalahkan id yang ditulis di config.toml.

Keduanya gak diberitahukan ke orangnya: balasan cuma mengundang mereka mencoba lagi, dan memberi tahu
bahwa botnya hidup.

![Tab Denied: dua penolakan yang menghitung mundur sampai mereka boleh minta lagi, masing-masing dengan Reset dan Block](/media/dashboard-access-denied.png)

Sebelum 0.7.0, Deny itulah block-nya: satu "tidak" yang ditekan pada kode yang gak dikenali membuat
orang itu tertolak selamanya, tanpa ada layar yang menunjukkannya. Penolakan dari sebelum pemisahan
ini ditampilkan sebagai block, sesuai artinya waktu itu, jadi upgrade gak membuka pintu untuk siapa
pun.

Dari terminal:

```bash
nouride access                          # siapa yang menunggu, yang sudah masuk, yang ditolak
nouride access approve <kode>           # tambahkan --me, --as <key orang> atau --new "<nama>"
nouride access deny <gateway:sender>    # tidak, selama sehari
nouride access block <gateway:sender>   # tidak, sampai di-unblock
nouride access revoke <gateway:sender>  # cabut persetujuan
nouride access reset <gateway:sender>   # akhiri masa tunggu deny sekarang
nouride access unblock <gateway:sender>
nouride access mode pair                # atau allowlist
```

Kalau dijalankan agent, `approve` dengan `--me`, `--as` atau `--new` menanyakan admin di setiap tingkat approval,
`trusted` juga: perintah itu menaruh pengirim kode pada seseorang, dan kalau tertaut ke admin, chat-nya menjawab
sebagai admin. Begitu juga `people set` dan `people remove` di bawah ([daftar tetap](/id/docs/manual/approvals/#daftar-tetap),
`people`, sejak 0.8.9).

Kode berlaku 15 menit, cukup lama untuk diteruskan, cukup singkat untuk gak menggantung. Ada juga
cooldown untuk balasan "saya gak mengenal kamu", supaya orang asing gak bisa membuat daemon menjawab
setiap pesan yang mereka kirim. Menolak, memblokir, atau mencabut akses seseorang juga menghapus
tingkat approval yang mereka set untuk diri sendiri, jadi kalau di-pair lagi mereka mulai dari default.

:::caution[Ini bukan antrean approval]
**Approval** adalah agent yang berhenti di tengah giliran karena ingin menjalankan perintah. **Access**
adalah orang yang meminta izin masuk sama sekali. Keduanya sengaja diletakkan di tempat berbeda.
Kegagalan yang membuat ini eksplisit: bot menyuruh seseorang menyetujui kode pairing, daftar approval
di dashboard kosong karena daftar itu untuk tool call, dan kode lima belas menit itu kedaluwarsa
sementara mereka mencarinya.
:::

## Default, dan milik tiap agent

Di dashboard, mode pairing adalah satu sakelar, *Accept new senders*, di halaman pengaturan **Agents**.
Itu **default**-nya: `[security.access] mode`, yang diikuti setiap agent.

Sebuah agent bisa memutuskan sendiri di halaman **Access**-nya, di bagian *Who can write to this
agent*. Itu satu pilihan dari empat: *Follow the default*, *Ask first* (orang baru mendapat kode
pairing), *Approved only* (hanya orang yang sudah diizinkan) atau *Open to everyone*. Tiga yang pertama
adalah `[agent] access = "follow" | "pair" | "allowlist"` di `config.toml`-nya, tersimpan dengan sekali
tekan, dan berlaku untuk setiap koneksi milik agent itu. Yang keempat meminta dua angka sebelum
disimpan, dan dijelaskan berikutnya.

![Tab Access sebuah agent: siapa yang boleh menulis kepadanya, satu pilihan dari empat, dan ringkasan pengirimnya](/media/dashboard-agent-access.png)

Di bawahnya, tab itu menghitung pengirim agent ini, yang menunggu, yang disetujui, dan yang di-deny
atau di-block, masing-masing tautan ke **Access** yang sudah tersaring untuk agent itu. Sakelar default
dan pilihan milik sebuah agent sama-sama langsung berlaku: pesan berikutnya dinilai dengan pengaturan
baru, tanpa restart.

## Agent yang terbuka untuk semua orang

Sejak 0.8.48 satu agent bisa menjawab siapa pun yang menemukannya, tanpa kode: meja depan toko, layanan
bantuan, bot untuk sebuah acara. Yang terbuka itu agent-nya, bukan instalasinya. Agent kamu yang lain
tetap meminta orang asing untuk pairing.

Di halaman **Access** agent itu, pilih **Open to everyone**, pilihan keempat di bagian *Who can write
to this agent*. Ia menjelaskan artinya sebelum kamu ambil:

- Siapa pun yang menemukannya bisa menulis ke dia, dan dia menjawab atas namamu. Orang bisa mencoba
  membujuknya mengatakan hal yang gak akan kamu katakan, jadi jauhkan apa pun yang pribadi dari file
  persona-nya, catatannya, dan apa yang kamu buka untuk semua orang.
- Setiap jawaban dibayar dari akun model-mu; dua angka di bawah adalah cara kamu mengendalikannya.
- Apa yang dikirim orang ke dia disimpan di server ini, bersama chat-nya.
- Kalau dia punya nomor WhatsApp, nomor itu berisiko: lihat [peringatan di halaman
  WhatsApp](/id/docs/gateways/whatsapp/#satu-nomor-untuk-tiap-agent). Form-nya juga mengatakannya,
  begitu juga halaman Access selama dia terbuka.

Lalu ia meminta dua angka:

- **Token terbanyak yang boleh dipakainya dalam sehari.** Semua yang ia habiskan dihitung, siapa pun
  yang dijawabnya. Begitu jatah hari itu habis, ia memberi tahu orang bahwa ia tutup sampai besok,
  dengan kalimat yang boleh kamu tulis sendiri, dan kamu diberi tahu sekali.
- **Pesan terbanyak yang boleh dikirim satu orang dalam sehari.** Lewat dari itu, orang tersebut
  diberi tahu sekali lalu gak dijawab sampai hari berikutnya.

Jatah hari itu dicek sebelum tiap jawaban, jadi jawaban yang sudah dimulai saat jatahnya habis tetap
selesai. Token yang dihitung adalah token model: transkripsi pesan suara gak dihitung di situ, dan
hanya terjadi untuk jawaban yang masih muat di jatah hari itu.

Dua-duanya gak punya nilai awal: ia menjawab pakai akun kamu, dan sebuah agent gak dibuka tanpa angka
yang kamu pilih. Satu hari itu harinya kamu, menurut zona waktu server, dan restart gak mengulang
hitungan mana pun. Orang yang kamu masukkan atas namanya gak kena dua batas itu. Hanya admin yang
membuka agent; operator boleh menutupnya.

Orang asing, semuanya bersama, paling banyak memakai separuh jawaban yang dikerjakan server sekaligus
(`[queue] max_concurrent_turns`), jadi kamu dan orang yang kamu masukkan dijawab di samping mereka,
bukan setelahnya.

### Apa yang bisa ia lakukan, dan apa yang ia tahu

Selama terbuka, sebuah agent punya empat tool dan gak ada yang lain, apa pun isi daftar Tools-nya:

| | |
|---|---|
| Mencari dan membaca | dokumen yang kamu buka untuk semua orang di **Knowledge** (koleksi yang pembacanya *Everyone*) |
| Membaca file | yang dikirim orang itu di chat |
| Mengirim file | yang disimpan di salah satu koleksi itu, ke chat yang sedang dijawabnya |

Koleksi untuk *Everyone* yang gak menyebut agent mana pun dibaca oleh setiap agent yang kamu buka, jadi
sebelum kamu memilihnya, form-nya menyebut koleksi mana saja yang akan dipakai agent ini untuk menjawab
orang asing.

Tanpa perintah, tanpa file server, tanpa web, tanpa agent lain, tanpa pengingat, tanpa memori sendiri.
Tab Tools-nya menampilkan semuanya dalam keadaan mati selama ia terbuka, dan menyimpan pilihanmu untuk
saat ia ditutup. Ia gak diberi tahu apa pun tentang kamu, orang-orang yang kamu masukkan, agent kamu
yang lain, atau server-nya, dan ia diberi tahu hal yang sama ketika *kamu* yang menulis kepadanya: bot
yang tahu lebih banyak untuk sebagian pengirim bisa dibujuk untuk mengatakannya ke yang lain. Gak ada
yang dikatakan sebuah chat kepadanya yang disimpan, dan percakapannya gak pernah masuk ke memori.

Yang ia tahu adalah apa yang kamu tulis untuknya: file persona dan catatannya. Baca dulu seperti orang
asing membacanya sebelum kamu membukanya. Agent yang punya catatan sendiri baru dibuka setelah kamu
centang bahwa kamu sudah membacanya, dan agent yang dibuat baru untuk publik adalah pilihan yang lebih
aman.

Dua agent gak pernah dibuka, dan kartunya menjelaskan kenapa: **agent utama**, yang mengurus server,
dan agent yang bekerja lewat **coding CLI**, yang membawa tool-nya sendiri yang gak bisa dicabut
Nouride. Sebaliknya juga berlaku: agent yang terbuka gak bisa dijadikan agent utama atau diserahkan ke
coding CLI sampai kamu menutupnya.

### Di chat

Orang yang masuk hanya karena agent-nya terbuka punya tiga perintah: `/start`, yang dikirim aplikasi
chat saat chat sebuah bot dibuka dan dijawab agent dengan sapaannya sendiri; `/new`; dan `/help`.
Di grup, `/new` bukan miliknya, karena percakapan di sana milik semua orang. Perintah lain dijawab
satu kalimat dan gak melakukan apa-apa, jadi gak ada yang bisa menidurkan bot
kamu atau mengganti modelnya. Orang yang kamu masukkan atas namanya tetap punya perintah yang mereka
punya di mana pun.

Menyebut agent lain gak sampai ke agent itu: pesan orang asing di bot agent yang terbuka adalah milik
agent itu saja. Dan apa yang dikatakan agent yang terbuka gak membangunkan agent lain, apa pun yang ia
tag.

Di grup ia menjawab hanya saat di-tag, disebut namanya, atau dibalas, apa pun pengaturan grup itu.
Siapa pun boleh memasukkan sebuah bot ke grupnya sendiri, dan bot yang menjawab setiap pesan akan
menghabiskan harinya untuk obrolan yang gak ditujukan kepadanya.

### Siapa yang menulis

Orang yang menulis ke agent yang terbuka gak ada di daftar mana pun di halaman Access: gak ada yang
diminta kode. Mereka ada di tab **Access** agent itu sendiri, di bawah **People who wrote**: siapa, di
aplikasi apa, apa yang pertama mereka tanyakan, dan kapan. **Read** membuka percakapannya; **Block**
menahan pengirim itu mulai pesan berikutnya. Kartu di atasnya menyebut berapa yang sudah terpakai hari
itu.

Percakapan itu gak masuk ke daftar chat kamu sendiri, dan hilang saat percakapan seumurnya hilang
(`retention.session_days`), termasuk file-nya.

Dari terminal, `nouride config check` dan `nouride doctor` menyebut agent mana yang terbuka, di koneksi
mana dan dalam batas berapa.

### Di file

```toml
# .nouride/agents/nora/config.toml
[agent]
access = "open"

[open]
max_daily_tokens = 200000
max_daily_messages_per_person = 30
closed_reply = "Kami tutup dulu hari ini. Silakan tulis lagi besok."   # opsional
```

`access = "open"` tanpa kedua angka itu gak dimuat, dan menyebut apa yang kurang. Menutup sebuah agent
menulis `access = "follow"` dan membiarkan `[open]` untuk lain kali.

### Instalasi yang dulu open

Sebelum 0.8.48, `[security.access] mode = "open"` membolehkan semua orang masuk di setiap koneksi, dan
daemon menolak start dengannya selama ada agent yang bisa menjalankan perintah. Itu sudah gak ada.
Start pertama 0.8.48 di instalasi seperti itu:

1. memasukkan atas namanya setiap orang yang sudah pernah dijawab sebuah agent di sana, di koneksi
   tempat mereka menulis;
2. menulis `mode = "pair"` ke `config.toml`.

Jadi semua yang sudah bicara dengannya tetap bisa bicara, dan pengirim baru diberi kode pairing. Gak ada
yang dibuka oleh upgrade ini: kalau kamu mau bot yang bisa ditulis siapa saja, buka agent itu seperti di
atas. `nouride config check` mengatakannya sebelum kamu upgrade.

## Menyetujui orang lebih awal

Untuk memasukkan seseorang sebelum dia pernah chat, izinkan dari terminal (hanya admin, sama seperti
approve):

```bash
nouride access allow telegram:nouva:123456789 --name "Sam"
```

Dia masuk ke **Approved** seolah-olah sudah pairing: Revoke dan Block berlaku untuknya, dan History
mencatat siapa yang memasukkannya. Pairing berlaku per koneksi, jadi orang di tiga bot berarti tiga
baris.

### Sekaligus satu daftar

Sejak 0.8.41 satu daftar bisa dimasukkan sekaligus, dari file berisi satu orang per baris:

```bash
nouride access allow --from contacts.txt --gateway whatsapp:main --dry-run   # menghitung, gak menulis apa-apa
nouride access allow --from contacts.txt --gateway whatsapp:main
```

Hal yang sama dari dashboard (0.8.42), untuk admin: di tab **Approved** halaman Access, tekan **Let in a list**.
Pilih koneksi tempat mereka akan menulis, tempel daftarnya atau pilih file-nya, lalu tekan **Check the list**: ia
bilang berapa yang akan dimasukkan dan apa yang ditinggal, tanpa menulis apa-apa. **Let N in** lalu memasukkan
mereka, dan hanya ditawarkan untuk daftar persis seperti yang sudah diperiksa.

File-nya teks biasa:

- Satu orang per baris: id-nya dulu, lalu nama kalau ada, setelah koma, titik koma atau tab. Semua
  setelah tanda pertama itu adalah namanya.
- Spreadsheet yang disimpan sebagai CSV bisa langsung dipakai, id di kolom pertama dan nama di kolom
  kedua, dengan atau tanpa tanda kutip di sel.
- Baris kosong dilewati, begitu juga baris yang diawali `#`.
- Baris yang bukan pengirim di koneksi itu, termasuk baris judul kolom, dihitung sebagai yang gak
  terbaca dan disebutkan di jawabannya. Sisanya tetap masuk.

```text
# WhatsApp: nomor telepon dengan kode negara
+62 812-3456-7890, Bu Rina
62 813 0000 0001
6281400000002;Pak Budi
```

```text
# Telegram: id akun atau username
123456789, Sam
@sam_lee
t.me/budi_santoso
```

```text
# Discord: id akun atau username
123456789012345678, Sam
sam.lee
```

Satu file untuk satu koneksi: daftar untuk `whatsapp:main` berisi nomor, daftar untuk bot Telegram
berisi id atau username. Isi satu baris tergantung koneksinya di mana:

| Koneksi | Satu baris berisi | Bukan |
|---|---|---|
| WhatsApp | nomor telepon dengan kode negaranya, ditulis bagaimana pun (`+62 812-3456-7890`) | nomor cara lokal, dari 0: negaranya gak ditebak |
| Telegram | id akun, atau username-nya (`@sam_lee`, `t.me/sam_lee`) | nomor telepon: Telegram gak memperlihatkan nomor siapa pun ke bot |
| Discord | id akun, atau username-nya (`sam.lee`) | nama lama `name#1234`, yang bisa dipakai beberapa akun |

Perintah ini bilang berapa yang baru, berapa yang sudah masuk, berapa yang diblokir dan tetap di luar,
berapa yang disebut dua kali, dan baris mana yang gak terbaca. Sampai 50.000 baris sekali jalan.
Seluruh daftar jadi satu baris di History. File yang gak boleh dibaca perintahnya (di server ia jalan
sebagai akun Nouride sendiri, siapa pun yang mengetiknya) diberikan lewat standard input:
`--from - < contacts.txt`.

Nama dari daftar ditampilkan sampai orang itu menulis. Sejak itu tab Approved menampilkan nama yang
dipakai akunnya, sama seperti siapa pun yang disetujui.

Di WhatsApp orang biasanya menulis ke kamu dengan id tersembunyi, bukan nomornya. Nouride diberi tahu
nomor di baliknya dan memasukkan dia lewat yang mana pun, jadi daftar nomor tetap jalan. Di Telegram
dan Discord, orang yang dimasukkan lewat username dikenal lewat username itu: kalau ia melepasnya dan
orang lain mengambilnya, orang lain itu yang masuk. Pakai id kalau itu penting.

Begitu ribuan orang di-approve, tab Approved menampilkan 500 yang terbaru dan bilang jumlah semuanya.
Untuk menjangkau yang di luar itu, ketik id atau namanya di filter lalu tekan **Search everyone**; dari
terminal, `nouride access approved --find <id atau nama>`.

Ini cara menjawab balasan dari satu daftar kontak tanpa membuka sebuah agent untuk semua orang: orang
yang kamu kirimi masuk atas namanya, dengan semua tool yang dimiliki agent kamu, dan orang lain tetap
bertemu kode. Catatan: WhatsApp di sini bukan Business API resmi: ia menautkan nomor
seperti WhatsApp Web, dan WhatsApp bisa membatasi atau memblokir nomor yang mengirim massal ke orang
yang belum pernah menulis ke nomor itu.

Config juga bisa melakukannya, untuk instalasi yang diatur lewat file, bukan lewat dashboard:

```toml
[security.access]
mode = "pair"
allowlist = [
  "123456789",                    # id polos
  "telegram:nouva:123456789",     # lengkap dengan koneksinya
]
```

Daftar ini berlaku di semua mode dan tampil di Approved sebagai *Allowed by config* kalau ada isinya,
tapi dashboard gak bisa me-revoke-nya; hanya block yang bisa mengalahkannya. Pakai bentuk lengkap kalau
satu daemon menjalankan bot di lebih dari satu platform: id Telegram dan snowflake Discord sama-sama
angka, dan id polos bisa cocok di platform yang salah.

## Pembatasan per agent

Aturan tingkat daemon menentukan siapa yang boleh mencapai para agent sama sekali. Satu agent bisa
lebih sempit:

```toml
# .nouride/agents/nouva/config.toml
[security]
sender_allowlist = ["telegram:nouva:123456789"]
```

Dua bentuk yang sama dengan allowlist tingkat daemon: lengkap dengan koneksinya
(`telegram:nouva:123456789`), atau id polos, yang cocok di semua koneksi milik agent itu. Kalau kosong,
ia gak mempersempit apa-apa: aturan tingkat daemon yang memutuskan sendiri.

## Nama, bukan id

Agent yang tahu sebuah chat id gak tahu apa-apa yang berguna. **People** mengikat sebuah akun ke
seseorang (nama, beberapa catatan, dan sebuah **person key**), dan fakta itu masuk ke prompt sehingga
agent memanggil orang dengan benar.

![Halaman People: satu entri per orang, dengan semua id tempat ia bisa dihubungi](/media/dashboard-people.png)

```bash
nouride people                                        # siapa yang dikenal agent, dan siapa yang belum bernama
nouride people set sam --name "Kak Sam"               # orang lewat key: ditambah dengan nama, belum ada akun
nouride people set telegram:123456789 --name "Sam" --note "Adiknya Alex"   # siapa pun pemegang akun itu
nouride people remove sam                             # lewat key, atau lewat akun yang dia pegang; memorinya tetap
```

Atau halaman **People** di dashboard, atau tool `person_record` milik agent sendiri.

**Tambahkan orang dengan namanya; sambungkan akunnya saat dia pairing.** Di halaman People cukup isi
nama. **Person Key** terisi sendiri dari nama itu (`Kak Sam` → `sam`) dan bisa diubah sebelum disimpan:
huruf kecil dan angka, kata-katanya disambung `-`, dan gak boleh sama dengan milik orang lain. Key itu
adalah orangnya sekaligus nama file memorinya (`people/sam.md`), jadi gak bisa diubah setelah disimpan.
Akunnya opsional: saat dia chat ke salah satu bot-mu dan minta pairing, **Approve as…** di halaman Access
menampilkan semua orang di People, jadi akunnya masuk ke orang yang sudah kamu tambahkan.

Notes berupa markdown, sepanjang yang diperlukan. Di halaman People,
**Notes** di tiap baris membukanya untuk dibaca dan diedit, dialog yang sama dengan di Memory. Admin
bisa mengedit notes siapa saja di sana. Lewat agent, orang hanya bisa mengubah notes-nya sendiri:
bilang ke agent "ulang tahunku 12 Mei" dan `person_notes` menambahkan baris itu ke notes-mu, tidak
pernah ke notes orang lain, siapa pun yang meminta. `person_record` cuma menulis baris pertama, untuk
orang yang belum dideskripsikan siapa pun, dan yang berubah seiring waktu (kerjaan, rencana, selera)
masuk ke profil memory orang itu.

Di disk setiap orang punya berkas sendiri (sejak 0.8.18), `people/<key>.toml` di samping `config.toml`, nama
berkasnya jadi key-nya. Satu orang bisa mengirim dari beberapa akun, dan di WhatsApp khususnya manusia yang sama
muncul dengan dua id (`…@s.whatsapp.net` dan `…@lid`); semuanya masuk ke `ids`, dan kosong pun boleh.
`people/sam.toml`:

```toml
[person]
name  = "Sam"
ids   = ["whatsapp:628123456789@s.whatsapp.net", "whatsapp:100000000000002@lid"]
notes = "Adiknya Alex. Lebih suka jawaban singkat."
```

Berkas yang diedit tangan dibaca di start berikutnya, dan tulisan berikutnya dari People atau agent menambalnya,
bukan mengembalikan isi yang lama. Berkas yang gak bisa dimuat disebut di log dan orang itu ditinggalkan sampai
berkasnya bisa dimuat. Sebelum 0.8.18 mereka adalah entri `[[people]]` di `config.toml`; start pertama 0.8.18
memindahkannya.

Setiap id terdiri dari platform dan akunnya (`telegram:…`, `discord:…`, `whatsapp:…`), dan mengenali
mereka di semua bot kamu yang mereka ajak bicara. Id yang ditulis dengan nama koneksi di tengah
(`whatsapp:nouva:…`), seperti sebelum 0.7.0, ditolak sejak 0.8.0 sambil menyebut id tanpa nama koneksi
itu. Access satu-satunya tempat koneksi itu berarti: di sanalah bot mana yang mengizinkan siapa.
Id polos ditolak, dengan alasan yang sama seperti di atas.

**Ini selamat dari `/new`.** Fakta di berkas seseorang dan di `MEMORY.md` sebuah agent
bersifat permanen; percakapan gak. Dengan memori menyala, para agent juga bisa belajar tentang tiap
orang seiring waktu (**Knowledge & Memory → People**, lihat [Memori](/id/docs/architecture/memory/)). Kalau agent
terus lupa siapa seseorang, faktanya memang harus ditaruh di salah satu tempat itu, bukan di chat.

:::note[Kosong adalah nilai yang sah]
Akun tanpa nama berarti belum ada yang menyatakan orang itu dipanggil apa, dan agent lalu gak memakai
nama sama sekali alih-alih jatuh ke handle login. Ini perbaikan untuk bug sungguhan: setup dulu
menanyakan "agent harus memanggil kamu apa", menulis jawabannya ke file yang dibaca setiap agent di
setiap percakapan, dan menyapa orang kedua yang mengirim pesan dengan nama orang pertama.
:::

## Akun dashboard itu terpisah

Siapa yang boleh masuk ke dashboard adalah pertanyaan berbeda dari siapa yang boleh mengirim pesan ke
bot. Akun dan peran ada di **Users**, khusus admin (akun multi-user adalah fitur edisi Pro).
Gak ada yang bisa menghapus akunnya sendiri, dan admin terakhir gak bisa diturunkan, karena itu akan
mengunci instance ini dari manajemen akun.

Yang dilihat sebuah akun adalah miliknya sendiri: [chat](/id/docs/manual/dashboard/#chat)-nya,
[automation](/id/docs/manual/schedule/#automation-ini-milik-siapa)-nya dan [misi](/id/docs/manual/missions/#memantaunya)-nya.
Admin melihat milik semua orang, dan memilih milik siapa di tiap halaman itu.
