---
title: Siapa yang boleh bicara
description: Pairing, allowlist, dan memberi agent nama untuk orang-orang yang diajaknya bicara.
---

Bot kamu berada di jaringan publik. Siapa pun yang menemukan username-nya bisa mengirim pesan, jadi
siapa yang boleh mencapai sebuah agent adalah pengaturan sungguhan, bukan renungan belakangan.

## Tiga sikap

`[security.access] mode`, berlaku untuk seluruh daemon:

| | |
|---|---|
| **`pair`** (default) | Pengirim asing diberi kode pendek lalu pesannya dibuang. Kamu menyetujui kodenya dan mereka diingat, di disk, permanen. |
| **`allowlist`** | Hanya id yang terdaftar atau sudah disetujui yang lewat. Sisanya dibuang **dalam diam**: tanpa balasan, tanpa error. |
| **`open`** | Siapa saja. Cuma masuk akal untuk daemon tanpa gateway chat sama sekali. |

Jalur biasanya: pasang dengan `pair`, lalu pindah ke `allowlist` setelah orang-orang yang kamu inginkan
masuk. Pengirim yang sudah disetujui tetap bisa bicara; sisanya dihentikan di gerbang.

`open` gak ditawarkan sebagai pilihan di dashboard. Ia sikap yang diperingatkan daemon, jadi
ditampilkan sebagai peringatan ketika sedang berlaku, bukan disajikan sebagai opsi.

## Menyetujui seseorang

Mereka mengirim pesan ke bot dan mendapat kode, dan balasannya menyebutkan di mana kode itu
disetujui, karena orang yang melakukan pairing biasanya orang yang menjalankan daemon-nya sendiri:

![Pesan pertama ke bot Telegram, dibalas dengan kode pairing dan cara menyetujuinya](/media/pairing-chat.svg)

Di grup, kodenya datang dari bot yang ia tag, sebut namanya, atau reply, dikutip di bawah pesannya. Bot
lain di grup tetap diam dan gak membuka permintaan, dan pesan yang gak menyapa agent mana pun gak
dapat apa-apa.

"Kirim kode itu ke siapa pun yang menjalankan saya" jadi jalan buntu kalau kamu **adalah** orang itu
dan gak ada yang memberi tahu bahwa ada halamannya. Jadi pesannya menyebutkan halaman itu.

**Overview memberi tahu bahwa ada, begitu juga sidebar:** angka di sebelah **Access**, di setiap
halaman, karena kodenya bisa kedaluwarsa. Baris di Overview berisi jumlah yang menunggu dan sebuah
tautan, tanpa tombol. Keduanya hanya muncul kalau memang ada yang mengantre; angka nol permanen adalah
sesuatu yang lama-lama berhenti kamu lihat.

Pemisahan itu disengaja. Overview adalah tempat melirik, dan menyetujui orang asing gak bisa
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

Filter agent menyaring kelimanya untuk satu agent, tiap daftar punya kotak filter dan di-scroll di dalam kartunya, dan tab **Access** milik tiap agent menghitung
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

Sebuah agent bisa memutuskan sendiri di halaman **Access**-nya: *Follow the default*, *On* (orang asing
mendapat kode pairing) atau *Off* (hanya pengirim yang sudah disetujui). Itu
`[agent] access = "follow" | "pair" | "allowlist"` di `config.toml`-nya, dan berlaku untuk setiap
koneksi milik agent itu. `open` bukan pilihan di sana: daemon sendiri menolak start dengan `open` dan
sender allowlist kosong selama ada agent yang bisa menjalankan perintah, dan jalan pintas per agent
akan membolongi penjaga itu.

![Tab Access sebuah agent: apakah pengirim baru boleh minta masuk, dan ringkasan pengirimnya](/media/dashboard-agent-access.png)

Di bawahnya, tab itu menghitung pengirim agent ini, yang menunggu, yang disetujui, dan yang di-deny
atau di-block, masing-masing tautan ke **Access** yang sudah tersaring untuk agent itu. Kedua sakelar
langsung berlaku: pesan berikutnya dinilai dengan pengaturan baru, tanpa restart.

## Menyetujui orang lebih awal

Untuk memasukkan seseorang sebelum dia pernah chat, izinkan dari terminal (hanya admin, sama seperti
approve):

```bash
nouride access allow telegram:nouva:123456789 --name "Sam"
```

Dia masuk ke **Approved** seolah-olah sudah pairing: Revoke dan Block berlaku untuknya, dan History
mencatat siapa yang memasukkannya. Pairing berlaku per koneksi, jadi orang di tiga bot berarti tiga
baris.

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

![Halaman People: satu entri per orang, dengan semua id tempat ia bisa dihubungi (catatan diburamkan)](/media/dashboard-people.png)

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
