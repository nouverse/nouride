---
title: Automations
description: Pekerjaan yang jalan tanpa ada yang mengetik, sesuai jadwal, saat webhook dipanggil atau saat kamu mulai sendiri, berupa satu hal atau beberapa langkah berurutan.
---

Automation adalah pekerjaan yang jalan ketika gak ada yang mengajak agent bicara. Ia punya **awal**, yang
menentukan kapan ia jalan, dan **langkah-langkah**, yang menentukan apa yang dikerjakan.

| Ia mulai | |
|---|---|
| **Sesuai jadwal** | ekspresi crontab (`0 9 * * *`), interval (`15m`, `2h`), atau sekali pada suatu waktu |
| **Saat dipanggil** | webhook: saat URL-nya dipanggil, bukan saat jam tertentu |
| **Manual** | saat kamu menekan **Run now** |

![Halaman Automations: tiap automation dengan pemicunya, langkah-langkahnya, dan hasil run terakhirnya](/media/dashboard-automations.png)

Halaman **Automations** di dashboard (Work → Automations) menampilkan semuanya, apa pun awalnya, dengan
satu dropdown untuk melihat yang terjadwal saja, yang webhook, atau yang manual. Di sanalah kamu membuat,
mengubah, menjalankan, menjeda, dan menghapusnya. Atau minta saja ke agent: "ingatkan aku cek deploy dua
jam lagi", lalu agent [mengusulkan](#diminta-ke-agent) automation-nya, dan kamu yang menyalakannya.

Daftarnya mencakup semua agent, bukan per agent, karena biasanya kamu ingin melihat semua milikmu yang jalan sendiri
sekaligus.

### Automation ini milik siapa

**Satu automation dimiliki satu orang** (0.8.35). Yang kamu buat di dashboard jadi milikmu. Yang diusulkan agent lalu
kamu nyalakan juga jadi milikmu, siapa pun yang memintanya. Halaman ini menampilkan milikmu, dan hanya pemiliknya atau
admin yang bisa mengubahnya: mengedit, menjalankan, menjeda, menghapus, atau menjawab langkah yang menunggu.

Kamu juga melihat automation milik orang lain yang melapor ke chat-mu, karena apa pun yang menulis ke chat-mu boleh
kamu baca. Barisnya menyebut milik siapa, bisa dibuka, langkah dan riwayat jalannya bisa dibaca, tapi tidak ada yang
bisa kamu ubah di sana. Alamat webhook hanya ditampilkan ke yang boleh mengubahnya.

Selain itu, operator atau viewer tidak pernah melihat milik orang lain: tidak di daftar, tidak juga lewat link-nya,
yang dijawab seolah automation itu tidak ada. Admin memilih milik siapa lewat dropdown di samping pencarian: **Mine**
(awalnya di sini), **Everyone**, yang memisahkan daftar per orang, satu orang (ketik sebagian namanya), atau
**Nobody's**. Nobody's adalah yang dibuat dari command line dan yang dari sebelum 0.8.35 yang pembuatnya tidak bisa
Nouride kenali. Di halaman satu automation, admin bisa menyerahkannya ke seseorang, atau ke tidak siapa pun: lewat
menu di kepala halaman, **Whose it is**.

Milikmu sendiri juga bisa kamu serahkan ke orang lain di sana (0.8.44), tapi tidak ke "tidak siapa pun". Kamu ditanya
dulu: setelah itu automation-nya jadi milik orang itu untuk diubah, bukan milikmu lagi, dan kamu hanya masih
melihatnya kalau ia melapor ke chat-mu.

Perubahan yang diusulkan agent atas automation yang sudah ada hanya bisa dinyalakan pemiliknya, atau admin: melihat
kartunya di sebuah chat belum cukup untuk mengubah milik orang lain.

Automation dari sebelum 0.8.35 jadi milik akun yang membuat atau menyalakannya. Yang diusulkan agent di sebuah chat
jadi milik orang yang menyalakannya di sana.

**Ini soal halaman, bukan soal apa yang agent tahu.** Satu agent bekerja untuk semua orang yang ngobrol dengannya:
ditanya di chat ada jadwal apa saja, ia menjawab dari semua automation yang ia punya, siapa pun pembuatnya, dan memori
serta file-nya menyimpan apa yang ia kerjakan untuk kalian masing-masing. Dua orang yang tidak boleh saling tahu
pekerjaannya butuh dua agent.

## Langkah-langkah

Automation mengerjakan satu hal, atau beberapa hal dengan urutan yang tetap. Tiap hal adalah satu langkah:

| Langkah | Yang dikerjakan | Memanggil model? |
|---|---|---|
| **Kirim pesan** | mengirim teks apa adanya ke chat automation itu | tidak |
| **Minta ke agent** | satu giliran agent pemilik automation, atau agent lain yang kamu pilih | ya, satu giliran |
| **Jalankan skrip** (*Run a script*) | menjalankan program kecil di workspace agent: [skrip](#skrip) yang disimpan automation itu, atau satu baris | tidak |
| **Mulai mission** | pekerjaan panjang yang dicek; automation menunggunya selesai | ya, seperti [mission](/id/docs/manual/missions/) |
| **Tunggu persetujuan** | bertanya ke orang, dan lanjut setelah dijawab ya | tidak |
| **Beberapa sekaligus** | memulai dua sampai lima giliran agent atau skrip bersamaan, lalu menggabung apa yang dikatakan masing-masing | ya, satu giliran untuk tiap agent di dalamnya |

Nouride menjalankan langkah-langkah itu sesuai urutannya, setiap kali. Tiap langkah menerima apa yang
dikatakan langkah sebelumnya, dan agent hanya mengerjakan langkah yang diberikan kepadanya: ia gak
melompat, gak mengubah urutan, dan gak menentukan sendiri apa berikutnya. Itu bedanya dengan
[mission](/id/docs/manual/missions/), di mana agent merencanakan sendiri pekerjaannya. Kata-kata langkah
terakhir adalah yang dikirim automation ke chat-nya.

Halaman automation menggambarnya sebagai kanvas (0.8.44): satu kotak untuk bagaimana ia mulai, satu kotak untuk
tiap langkah sesuai urutan jalannya, dan satu kotak untuk ke mana hasilnya dikirim. Tekan sebuah kotak dan isiannya
terbuka di samping kanvas kalau jendelanya lebar, atau di dalam kotak itu sendiri kalau lebih sempit dan di ponsel;
kalau gak ada yang ditekan, run-run terakhir ada di sana. **Add a step** ada di bawah langkah terakhir, tanda plus muncul di garis antara dua kotak,
dan kotak bisa diseret untuk dipindah. Gak ada yang berubah sebelum kamu menekan **Save**.

Yang belum kamu simpan disimpan sementara di browser tempat kamu membuatnya (0.8.45), jadi halaman yang kamu
tinggalkan terbuka lagi dengan perubahanmu, dan bilang begitu. Di daftar Automations, automation yang sedang kamu
buat dan belum pernah disimpan muncul sebagai baris sendiri, dengan **Continue** dan **Discard**, dan automation
yang punya perubahan menunggu di halamannya diberi tanda **Unsaved changes**. **Save** dan **Cancel** (atau
**Discard changes**) yang mengakhirinya. Ia hanya ada di browser itu: gak ada di ponselmu, dan gak dilihat orang
lain. Kalau automation-nya diubah orang lain selagi perubahanmu menunggu, halaman menampilkannya seperti yang
tersimpan sekarang dan menawarkan perubahanmu di sampingnya.

Bilah untuk menyimpan bilang apa yang masih kurang, satu per satu. Tekan baris itu dan kamu dibawa ke sana: isian
nama, atau kotak yang memuatnya, dalam keadaan terbuka.

![Halaman satu automation: kotak untuk awalnya, kotak untuk tiap langkah beserta apa yang terjadi kalau gagal, dan run terakhirnya](/media/dashboard-automation-steps.png)

### Ke mana automation lanjut

Langkah yang selesai lanjut ke langkah berikutnya. Apa yang terjadi kalau ia **gagal** ditanyakan di langkah itu
sendiri, dengan empat jawaban (0.8.44):

| Kalau gagal (*If it fails*) | |
|---|---|
| **Stop and tell me** | automation berakhir sebagai gagal, dan chat-nya dikabari kenapa. Ini yang terjadi kalau kamu gak memilih yang lain |
| **Go on anyway** | automation lanjut ke langkah berikutnya, yang menerima apa yang tadinya diberikan ke langkah yang gagal. Langkah agent juga diberi tahu apa yang gagal, dan kenapa |
| **Ask me first** | kamu ditanya, beserta kenapa ia gagal. Ya berarti lanjut, tidak berarti berhenti di situ |
| **Do something else** | langkah lain jalan menggantikannya. Langkah-langkah itu digambar di samping langkahnya (di bawahnya, menjorok, kalau gak ada ruang di samping), dan berakhir dengan salah satu dari dua cara: kembali ke langkah-langkah di bawah, atau berhenti |

Kotak tiap langkah bilang apa yang terjadi kalau ia gagal (0.8.45): langkah yang dibiarkan di "Stop and tell me"
menuliskannya di bawah kata-katanya, dengan tanda berhenti, dan "Go on anyway" serta "Ask me first" juga ditulis di
sana, lengkap dengan pertanyaannya dan ke mana tiap jawaban membawa. Jawaban **tidak** pada langkah yang menunggu
persetujuan ditanyakan dengan cara yang sama: berhenti di situ, lanjut saja, atau kerjakan hal lain.

Langkah-langkah yang jalan menggantikan sebuah langkah juga menjawab untuk dirinya sendiri (0.8.45): masing-masing
bisa berhenti, dan itu yang terjadi kalau kamu gak memilih yang lain, atau lanjut saja. Pertanyaan atau langkah
pengganti sendiri hanya dimiliki langkah di jalur utama. Di mana langkah-langkah itu berakhir ditulis di bawahnya,
dan tanda itu bisa ditekan untuk mengubahnya: **kembali** ke langkah mana pun yang lebih bawah di jalur utama,
masing-masing disebut dengan nomornya, atau **berhenti**. Sebuah benang digambar dari tanda itu ke langkah tempat
mereka kembali, dan langkah itu menyala saat penunjuk ada di atas tandanya. Pilihan yang sama ada di isian tiap
langkah itu.

Langkah yang **gak punya apa-apa untuk dikatakan** (skrip yang gak mencetak apa pun, agent yang gak punya laporan)
mengakhiri automation dengan diam, jadi pengecekan yang gak menemukan apa-apa gak membangunkan siapa pun. Di bawah
**More about this step**, ia bisa dibuat lanjut saja, atau mengerjakan hal lain.

Automation hanya bisa maju, jadi ia pasti selesai. Automation yang ditulis dari command line atau oleh agent bisa
punya jalur yang gak punya gambarnya di halaman ini, misalnya lompatan dari satu langkah ke langkah yang lebih bawah:
jalur itu ditampilkan sebagai label kecil di bawah langkahnya dengan garis ke tempat ia mendarat, dan tetap seperti
itu sampai kamu memilih jawaban lain.

Contoh, pengecekan toko:

1. **Jalankan skrip** yang menanyakan apakah toko menjawab: ia gak mencetak apa pun selama toko menjawab, dan gagal
   kalau tidak. Kalau gagal, **Do something else**:
   - **Minta ke agent**: "Tokonya mati: cari tahu kenapa."
   - **Tunggu persetujuan**: "Restart tokonya?"
   - **Mulai mission**: "Restart toko dan pastikan ia menjawab."

Selama toko menjawab, automation berhenti di langkah 1 dan gak ada model yang dipanggil. Saat toko mati,
agent memeriksanya, kamu ditanya, dan baru dengan jawaban ya dari kamu sesuatu di-restart.

### Skrip

**Run a script** menjalankan program kecil tanpa model (0.8.44): beberapa baris shell, Python atau JavaScript yang
mengambil sebuah halaman, membandingkan angka, memanggil layanan, atau mengubah bentuk sesuatu, dengan cara yang sama
setiap kali. Skripnya disimpan oleh automation itu sendiri. Jadi yang jalan adalah yang kamu baca sebelum
menyalakannya, dan mengubahnya sama seperti mengubah automation: perubahan yang diusulkan agent menunggu sebagai
**Suggested**, dengan teks skripnya bisa dibaca dalam bentuk sekarang dan bentuk usulannya.

- Ia **membaca** apa yang dikatakan langkah sebelumnya (untuk langkah pertama, apa yang dikirim ke webhook), dan apa
  yang ia **cetak** diteruskan ke langkah berikutnya.
- Gak mencetak apa pun berarti "gak punya apa-apa untuk dikatakan". Berakhir dengan error berarti gagal, dengan apa
  yang ia tulis sebagai alasannya. Jadi pengecekan yang belum punya apa-apa untuk dilaporkan harus berakhir tanpa
  error: di skrip shell, `if [ -f done ]; then cat done; fi`, bukan `test -f done && cat done`, yang berakhir dengan
  error selama file-nya belum ada.
- Ia jalan di workspace agent, seperti perintah agent itu, tanpa model dan tanpa bertanya dulu. Ia diberi kunci
  tersimpan yang kamu sebut di langkahnya, di antara yang memang boleh dipakai perintah agent itu; skrip membaca
  tiap kunci lewat namanya dalam huruf besar, `notes_key` jadi `NOTES_KEY`.
- Bahasa penulisannya dicek saat kamu menyimpan: program yang gak ada di mesin disebut saat itu, bukan jam 07:00.

Di halaman, skrip dibaca dengan kata-kata dulu: apa yang ia kerjakan, siapa penulisnya, ditulis dengan apa dan
seberapa panjang, serta kunci yang ia pakai. **Show the script** membuka teksnya, untuk dibaca atau diubah. **Try it**
menjalankannya sekali dengan apa yang dikatakan langkah sebelumnya di run terakhir, atau dengan yang kamu ketik, lalu
menampilkan apa yang ia cetak, paling lama satu menit. Itu jalan sungguhan: skrip yang mengirim atau menyimpan sesuatu
benar-benar melakukannya. Tombol di sampingnya meminta orchestrator menulis atau mengubah skrip itu, dengan langkah
dan automation-nya disebut di permintaannya.

Kamu gak harus menulisnya sendiri. Minta automation-nya ke agent, dan kalau pekerjaannya sama setiap kali, agent
menulis skripnya, mencobanya, lalu [mengusulkannya](#diminta-ke-agent): kartunya menyebut apa yang dikerjakan skrip
itu, dijalankan dengan apa, seberapa panjang, dan kunci yang diberikan kepadanya, serta menampilkan teksnya. Halaman
automation yang belum dinyalakan menampilkan hal yang sama, di bawah **Show the script**.

Automation dari sebelum 0.8.44 berisi perintah satu baris di tempat skrip. Ia jalan seperti biasanya, dan gak
menerima apa yang dikatakan langkah sebelumnya. Langkahnya menawarkan **Write it as a script instead**.

### Beberapa sekaligus

Satu langkah bisa memulai beberapa hal sekaligus (0.8.38): dua sampai lima, masing-masing berupa pertanyaan ke agent
atau perintah yang dijalankan. Semuanya mulai bersamaan, masing-masing menerima apa yang dikatakan langkah
sebelumnya, dan langkah itu selesai saat yang terakhir selesai. Apa yang mereka katakan diteruskan sebagai satu teks,
masing-masing di bawah namanya (nama yang kamu beri, nama agent, atau perintahnya), tanpa model di antaranya. Kalau
ini langkah terakhir, teks itulah yang dikirim automation.

Contohnya, ronde pagi:

1. **Beberapa sekaligus**: Nix membaca berita, Nox membaca kalender, dan `gh issue list` dijalankan.
2. **Minta ke agent**: "Tulis catatan pagi dari apa yang mereka katakan."

- **Kalau salah satunya gagal**, langkah itu mengambil jalur gagalnya. Kalau dibiarkan, automation berakhir sebagai
  gagal dan menyebut yang mana yang gagal; apa yang dikatakan yang lain tetap tersimpan di halaman run itu. Kalau
  diteruskan ke langkah lain, langkah itu menerima apa yang dikatakan yang lain beserta yang mana yang gagal dan
  kenapa.
- **Agent yang sedang tidur atau sibuk** dihitung sebagai kegagalan yang satu itu, padahal langkah yang berdiri
  sendiri akan mengakhiri automation sebagai dilewati: hasil kerja yang lain tetap dipakai.
- **Kalau tidak ada satu pun yang punya sesuatu untuk dikatakan**, langkah itu mengambil jalur diamnya. Satu yang
  diam di antara yang lain tidak dimasukkan ke teksnya.
- **Satu agent mengambil satu.** Dua giliran satu agent pada saat yang sama adalah dua langkah, satu setelah yang
  lain. Mission dan menunggu persetujuan juga langkah tersendiri.
- Tiap giliran agent berbiaya satu giliran, dan mereka jalan bersamaan: tiga agent berarti tiga giliran sekaligus.

Halaman sebuah run menyebut bagaimana jalannya masing-masing, di bawah langkahnya.

### Mission di tengah

Mission boleh jadi langkah di posisi mana pun. Automation menunggunya selesai, selama apa pun dan walau
Nouride restart di tengah jalan, lalu meneruskan hasilnya ke langkah berikutnya. Mission yang gagal atau
dihentikan dihitung sebagai langkah gagal, jadi automation bisa lanjut ke langkah yang mengabari kamu.

### Langkah yang menunggu kamu

Chat automation itu mendapat kartu berisi pertanyaannya, apa yang dikatakan langkah sebelumnya, dan dua
tombol, **Continue** dan **Stop**. Pertanyaan yang sama ada di dashboard, di **Waiting for you** dan di
halaman automation itu sendiri. Continue meneruskan apa yang dikatakan langkah sebelumnya ke langkah
berikutnya. Stop, atau gak ada jawaban dalam waktu yang diberikan langkah itu (sehari kalau gak diatur,
bisa lima menit sampai tujuh hari), mengakhiri automation di situ: gak ada langkah sesudahnya yang jalan,
dan itu gak dilaporkan sebagai gagal. Di chat satu lawan satu, orang di chat itu yang menjawab; di grup,
orang yang menyalakan automation-nya, atau admin. Selama menunggu gak ada model yang dipanggil, dan
penantiannya bertahan walau Nouride restart.

Kalau chat-nya gak punya tombol, seperti WhatsApp, kartunya meminta dijawab di dashboard.

### Satu jalan dalam satu waktu

Selama satu jalan masih menunggu, entah mission atau kamu, automation itu gak memulai jalan lain: waktu
berikutnya dihitung sejak jalan itu selesai, dan **Run now** mengatakan apa yang sedang ditunggunya.

## Dari CLI

```bash
nouride cron                     # yang terjadwal dan aktif
nouride cron --all               # termasuk yang dinonaktifkan
nouride cron run <id>            # jalankan sekarang
nouride cron runs <id>           # riwayatnya, dengan hasil tiap langkah
nouride cron continue <run id>   # jawab ya untuk jalan yang langkahnya menunggu orang
nouride cron stop <run id>       # atau hentikan di situ
nouride cron enable|disable <id>
nouride cron rm <id>
```

### Membuatnya

```bash
nouride cron add --name "morning-brief" \
  --cron "0 9 * * *" --tz Asia/Jakarta \
  --agent nouva \
  --gateway telegram:nouva --chat 123456789 \
  --message "Rangkum apa yang berubah semalam dan apa yang menunggu saya."
```

| Flag | |
|---|---|
| `--name` | namanya |
| `--cron "0 9 * * *"` / `--every 15m` / `--at 2h` / `--manual` | pilih tepat satu. `--manual` gak punya waktu: ia jalan saat ada yang memulainya |
| `--tz <zona>` | jam mana yang dipakai membaca jadwalnya |
| `--agent <id>` | agent yang memilikinya. Dari panggilan agent sendiri, agent itu |
| `--gateway <id> --chat <id>` | ke mana hasilnya dikirim. Wajib dari terminal; dari panggilan agent sendiri, percakapannya |
| `--message <prompt>` | bangunkan agent dengan ini |
| `--text <pesan>` | kirim teks biasa. Tanpa panggilan model, tanpa biaya |
| `--command <shell>` | jalankan sebuah perintah. Tanpa panggilan model |
| `--script <file> --about <kata-kata>` | jalankan [skrip](#skrip) yang disimpan automation itu: teks file-nya, dan satu baris tentang apa yang ia kerjakan. Tanpa panggilan model |
| `--run <program>` | …dijalankan dengan apa: `sh` kalau gak disebut, `python3`, `bun` |
| `--secrets <nama,nama>` | …secret milik agent yang diberikan kepadanya, lewat namanya |
| `--then agent` | …lalu bangunkan agent dengan apa yang dicetaknya, kalau ia mencetak sesuatu |
| `--mission <goal>` | jalankan setiap kali sebagai mission. Dengan `--check <perintah>` untuk satu cek, `--no-review` tanpa reviewer; cek lebih banyak dari dashboard |
| `--steps <file.json>` | beberapa hal di atas dengan urutan tetap: daftarnya, dalam JSON (di bawah) |
| `--session <fresh\|isolated\|chat>` | riwayat apa yang dilihat giliran itu |
| `--once` | mengabari sekali, lalu mematikan dirinya ([Mengawasi sesuatu](#mengawasi-sesuatu)) |
| `--for <6h>` | berhenti sendiri setelah selama itu, dan mengabarkannya di tempat ia melapor |
| `--quiet` | gak mengirim apa pun, termasuk kabar gagal; hasilnya tetap ada di `nouride cron runs` |
| `--keep` | simpan job sekali-jalan setelah menyala: dimatikan, dan tercatat sebagai `fired` |

`nouride cron update <id>` menerima `--name`, flag jadwal, `--tz`, `--text`, `--message`, `--steps` dan
`--agent`.

Daftar langkah ditulis di file, karena gak muat di satu baris perintah. Tiap langkah punya `kind` dan apa
yang dibutuhkan jenis itu, dan boleh menentukan ke mana automation lanjut darinya (`then`, `whenFailed`,
`whenEmpty`: `"next"`, `"end"`, atau nomor langkah yang lebih bawah). Pengecekan toko di atas:

```json
[
  { "name": "Check the shop", "kind": "command", "argv": ["sh", "-lc", "curl -sf https://shop.example.com/health"], "then": "end", "whenFailed": "next" },
  { "kind": "agentTurn", "message": "The shop is down: find out why." },
  { "kind": "approval", "ask": "Restart the shop?" },
  { "kind": "mission", "goal": "Restart the shop and confirm it answers." }
]
```

```bash
nouride cron add --name "shop-check" --every 10m --steps shop-check.json \
  --agent nouva --gateway telegram:nouva --chat 123456789
```

Jenis lainnya adalah `systemEvent` (pesan, dengan `text`) dan `parallel` (beberapa sekaligus, 0.8.38): `steps`-nya
berisi dua sampai lima `agentTurn` dan `command`, ditulis seperti langkah-langkah itu. `agentTurn` dan `mission`
menerima `agentId` untuk agent lain, dan `approval` menerima `timeoutMs`. Nouride membaca file itu dan menolak
langkah yang gak bisa dijalankannya, dengan menyebut langkahnya.

Langkah `command` yang menyimpan skrip (0.8.44) hanya menyebut programnya di `argv` dan menaruh teksnya di sampingnya:

```json
{ "name": "Save it", "kind": "command", "argv": ["python3"],
  "script": { "about": "Saves the summary as today's page.", "text": "import sys\nprint(len(sys.stdin.read()))\n", "secrets": ["notes_key"] } }
```

```json
{ "kind": "parallel", "whenFailed": "next", "steps": [
  { "name": "News", "kind": "agentTurn", "message": "Read today's news and say what matters.", "agentId": "nix" },
  { "kind": "command", "argv": ["sh", "-lc", "gh issue list --limit 5"] }
] }
```

`nouride cron runs <id>` mencantumkan masing-masing di bawah langkahnya, beserta bagaimana jalannya.

### Empat jenis job, dan biayanya

**`--text`** adalah pengingat biasa. Gak ada model yang dipanggil, jadi gratis. Pakai ini kapan pun
pesannya memang intinya.

**`--command`** menjalankan satu baris shell dan mengirim output-nya. Juga tanpa panggilan model.
`--then agent` menambahkan satu: agent membaca output-nya lalu melaporkan, dan itulah bedanya antara
"ini pemakaian disk" dengan "disk mulai penuh, ini yang memakannya". Run yang tidak mencetak apa pun
tidak mengirim apa pun, dan dengan `--then agent` tidak membangunkan siapa pun: cek yang hanya mencetak
saat ada masalah tidak memakan biaya selama semuanya baik. Perintah yang gagal tetap dikabarkan di chat.

**`--script`** adalah perintah yang lebih dari satu baris, disimpan di automation-nya (0.8.44): `nouride cron add
--name "backup-watch" --every 30m --script check.sh --about "Says once the backup is done." --once --for 6h …`.
Biayanya sama dengan perintah, yaitu nol. Lihat [Skrip](#skrip) untuk apa yang ia baca dan cetak.

**`--message`** membangunkan agent dengan sebuah prompt. Satu giliran, dengan tool, dengan biaya biasa.

**`--mission`** memulai sebuah [mission](/id/docs/manual/missions/) setiap kali jadwalnya tiba: kerja
panjang yang melebihi satu giliran. Mission ini tahan restart, bertanya di chat job-nya kalau butuh
orang, dan dianggap selesai begitu cek-nya lolos dan reviewer setuju. Gak ada yang perlu menerima
setiap run, karena pembuat job sudah menyetujui kerjanya waktu itu. Hanya satu yang jalan dalam satu
waktu: run yang jatuh tempo selagi run sebelumnya masih bekerja dicatat sebagai skipped. Reviewer
memakan kira-kira satu giliran per run, jadi job yang cek-nya sudah jadi jawaban lengkap bisa tanpa
reviewer. Body dari webhook sampai ke halaman run sebagai data, gak pernah sebagai perintah. Chat-nya
diberi kabar waktu run selesai, butuh orang, atau berakhir, bukan waktu run mulai sesuai jadwal.

### Riwayat apa yang dilihat giliran itu

`--session` adalah pengaturan yang paling sering diinginkan orang dan paling jarang ditemukan.

| | |
|---|---|
| `fresh` (default) | tanpa riwayat. Agent mulai bersih setiap kali |
| `isolated` | thread pribadi dan persisten untuk job ini, ia mengingat run-run sebelumnya, dan gak lebih |
| `chat` | percakapan chat tujuan, seolah kamu mengetik prompt itu di sana |

## Diminta ke agent

Minta di chat, misalnya "tiap Senin jam 9, rangkum email pelanggan untuk tim", dan agent
**mengusulkan** automation-nya lewat tool `schedule`: satu hal, atau daftar langkah beserta ke mana
tiap langkah meneruskan jalannya. Agent menulisnya lengkap, membiarkannya mati, dan mengirim kartu ke
chat, tiap langkah di barisnya sendiri:

```
📋 nouva proposes a scheduled job: Customer mail
When: cron `0 9 * * 1` (Asia/Jakarta)
Does: a mission for nouva: "Sum up last week's customer mail for the team.", then a reviewer agrees
Results: here
It stays off until somebody turns it on.          [Turn on] [Discard]
```

Kalau pekerjaannya sama setiap kali (mengambil halaman, membandingkan angka, memanggil layanan), agent
menulisnya sebagai [skrip](#skrip), mencobanya sekali, dan mengusulkan itu (0.8.44): gak ada model yang dipanggil
saat ia jalan. Kartunya menyebut apa yang dikerjakan skrip itu, dijalankan dengan apa, seberapa panjang, dan kunci
yang diberikan kepadanya, serta menampilkan teksnya; kalau terlalu panjang untuk satu pesan, kartunya bilang begitu,
dan teksnya dibaca di halaman automation itu sebelum kamu menyalakannya. Pekerjaan yang butuh membaca, menilai, atau
menulis tetap jadi giliran agent.

Gak ada yang jalan sebelum ada yang menjawab. **Turn on** menyalakan jadwalnya, dan mission-nya jalan
atas nama orang yang menekannya. **Discard** membuang usulannya. Di chat satu lawan satu, orang di chat
itu yang menjawab; di grup, orang yang meminta atau admin. Kalau chat-nya gak punya tombol, seperti
WhatsApp, kartunya menyebut perintahnya: `/schedule on <id>` dan `/schedule discard <id>`. Halaman
Automations menampilkan usulan dengan dua tombol yang sama, dan kartu yang dijawab dari sana ikut
berubah di chat.

Hasilnya datang ke chat tempat kamu memintanya. Minta dikirim ke tempat lain ("terus kirim ke WhatsApp
saya", "ke grup keluarga") dan agent menyebut chat itu di usulannya. Kartunya lalu menulis ke mana hasil
tiap run dikirim, `Results: sent to the whatsapp one-to-one with Gading, not here`, begitu juga halaman
automation-nya. Menyalakannya adalah "ya" kamu untuk itu, dan untuk apa pun yang dikirim langkahnya: run
gak ditahan untuk bertanya lagi.

Agent gak pernah menyalakan job sendiri, memperluasnya, atau mengubah job yang sedang jalan. Perubahan
adalah usulan baru yang menyebut job yang diganti; setelah dinyalakan, job itu berubah bentuk tapi tetap
memakai id, riwayat run, dan URL webhook-nya. Di halaman automation itu, perubahannya menunggu sebagai
**Suggested**, dengan apa yang ditambah, diubah, dan dihapus, serta tombol **Accept** dan **Discard**. Agent yang menjalankan `nouride cron add`, `update` atau
`enable`, atau `webhook add` atau `rotate`, ditolak dan diarahkan ke `schedule`. Paling banyak sepuluh
usulan dari satu agent yang boleh menunggu sekaligus, dihitung dari agent yang mengusulkannya.

Yang menjawab usulan cuma orang, gak pernah agent. Ada yang cuma bisa dinyalakan admin, siapa pun yang meminta:
perubahan pada job milik agent lain, perubahan pada job yang melapor ke chat lain, dan webhook, sama seperti
membuatnya. Izin *allow always* milik job lama gak ikut ke bentuk barunya: ia bertanya lagi.

## Mengawasi sesuatu

"Kabari aku kalau disk hampir penuh" adalah pengecekan berkala. Kalau dibiarkan begitu saja, ia mengabari setiap kali
jalan, selama disk masih penuh, termasuk jam tiga pagi. Tiga tanda membuatnya jadi pengawas (0.8.35), dan tanda
keempat mengakhiri pengawas yang saatnya gak pernah datang (0.8.44).

**Langkah yang lanjut hanya kalau ada yang berubah.** Tandai sebuah langkah (perintah, giliran agent, atau misi) dengan
**Go on only when this changes**. Apa yang ia katakan dibandingkan dengan yang ia katakan terakhir kali automation itu
jalan sampai selesai. Kalau sama, jalannya berhenti di situ dengan tenang, seperti langkah yang tidak punya apa-apa
untuk dikatakan: tidak ada agent yang dibangunkan, tidak ada yang dikirim. Jalan pertama belum punya pembanding, jadi
lanjut. Langkah yang gagal tidak dibandingkan. Yang disimpan Nouride adalah sidik jari dari ucapan langkah itu, bukan
kata-katanya.

Misi adalah satu-satunya pengecualian dari "tidak ada yang dikirim": misi mengabari chat-nya sendiri soal hasilnya,
setiap kali. Pada misi, tanda ini hanya menentukan apakah jalannya lanjut ke langkah sesudahnya.

Jadi pengecekan tiap sepuluh menit mengabari sekali saat disk lewat 90%, sekali lagi saat lewat 95%, dan sekali saat
sudah turun lagi: setiap kali hasil ceknya berubah.

**Automation yang mengabari sekali saja.** Nyalakan **Tell me once, then turn off** di bagian tempat ia melapor. Setelah
jalan pertama (yang jalan sendiri) mengabari sesuatu, automation itu mematikan dirinya, dan halamannya bilang begitu.
Nyalakan lagi kalau mau dikabari sekali lagi. Jalan yang kamu mulai sendiri tidak dihitung: itu kamu sedang mencoba.
"Kabari aku kalau build-nya selesai" adalah tanda ini, pada pengecekan yang ditandai lanjut hanya kalau berubah. Kabar
dari misi ke chat-nya ikut dihitung sebagai mengabari, jadi automation yang berisi misi mati setelah jalan pertama yang
sampai ke misi itu.

**Automation yang berhenti sendiri.** Pengawas untuk sesuatu yang gak pernah terjadi akan mengecek selamanya. **Stop by
itself after** (0.8.44), di bagian tempat ia melapor, memberinya batas waktu: satu jam, enam jam, satu hari, satu
minggu, atau tiga puluh hari, dihitung sejak ia dinyalakan. Saat waktunya habis ia mematikan dirinya dan mengabarkannya
di chat-nya, termasuk bahwa yang ia awasi gak terjadi, dan halamannya juga bilang begitu. Nyalakan lagi untuk memberinya
waktu yang sama sekali lagi. Hanya automation yang jalan berulang sesuai jam yang bisa punya batas ini, dan batasnya
harus cukup panjang untuk memuat satu jalan.

**Minta ke agent.** "Kabari aku kalau disk lewat 90%" di chat: agent mengusulkan pengecekan berkala dengan tanda-tanda
ini, berupa skrip kalau bisa, kartunya menyebutkannya dengan kata-kata, dan kamu yang menyalakannya. Pengawas yang
diusulkan agent untuk mengabari sekali selalu menyebut berapa lama ia berjalan, jadi gak ada yang dibiarkan mengecek
selamanya.

### Jam tenang

Satu pengaturan untuk seluruh instalasi, di halaman Automations: dua jam dalam sehari, di zona waktu server, dan di
antaranya apa yang mau dikatakan automation ke chat disimpan dulu. Automation tetap jalan, jadi apa yang berubah di
malam hari diketahui di pagi hari. Saat jam tenang berakhir, tiap chat mendapat satu pesan: setiap automation yang
punya sesuatu untuk dikatakan, dengan namanya, apa yang ia katakan dan kapan, yang gagal lebih dulu. Pertanyaan yang
ditunggu sebuah langkah juga ditanyakan saat itu, dan waktu menjawabnya dihitung dari saat itu; sementara itu ia ada di
**Waiting for you** di dashboard. Selama ada yang disimpan, halaman Automations menyebut berapa pesan dari
automation-mu yang sedang ditahan, di samping jamnya.

Tiga hal tetap disampaikan jam berapa pun: automation dengan **Tell me at once, even in quiet hours** menyala, untuk
yang tidak bisa menunggu pagi (kamera di pintu); jalan yang kamu mulai sendiri, karena kamu memang sedang di situ; dan
apa yang dikirim automation ke sebuah URL, bukan ke chat. Misi mengabari chat-nya sendiri soal hasilnya, dan tidak
ditahan.

Admin yang mengatur jamnya. Kosongkan kedua jam untuk tidak ada, dan begitulah awalnya. Di `config.toml`:
`[cron] quiet_hours = "22:00-07:00"`.

## Webhook

Endpoint yang menjalankan sebuah job ketika ada yang memanggilnya.

![Automation yang dimulai webhook: alamatnya, cara memanggilnya, dan langkah yang dijalankannya](/media/dashboard-webhooks.png)

```bash
nouride webhook                  # apa yang ada, beserta URL-nya
nouride webhook add --name "deploy-finished" \
  --agent nouva \
  --gateway telegram:nouva --chat 123456789 \
  --message "Deploy baru saja selesai. Cek endpoint health lalu laporkan."
nouride webhook rotate <id>      # terbitkan URL baru; yang lama berhenti jalan
```

Pakai `nouride cron` untuk `rm`, `enable`, `disable`, `run` dan `runs`: job-nya sama.

Sengaja **gak ada `--command` untuk webhook**. Webhook bisa dijangkau apa pun yang mengetahui URL-nya;
endpoint yang menjalankan argv di host adalah remote shell dengan password panjang.

Setiap panggilan dihitung di kartunya sebagai satu pengiriman, dan webhook yang panggilannya gagal
`fail_streak_limit` kali berturut-turut menjeda dirinya sendiri, seperti job terjadwal. **Run now**
menjalankan job secara manual, tanpa body, dan gak dihitung sebagai pengiriman.

### Skrip di depan webhook

Kalau langkah pertama automation sebuah webhook adalah perintah, perintah itu menerima kiriman si pemanggil lewat
standard input, tidak pernah lewat argumen atau environment-nya. Apa yang ia cetak itulah yang diterima langkah
berikutnya. Kalau tidak mencetak apa-apa, jalannya berhenti di situ: skrip yang menentukan panggilan mana yang layak
dikerjakan agent, dan bagian mana dari tiap panggilan yang dibaca agent.

```sh
# Langkah 1, perintah: hanya orang di pintu yang lanjut. Selain itu berhenti di sini, tanpa biaya model.
jq -r 'select(.event == "person") | "Ada orang di kamera \(.camera)."'
```

Langkah agent sesudahnya menerima baris itu, dan diberi tahu bahwa isinya datang dari luar. Ia tidak lagi melihat
kiriman asli si pemanggil, jadi cetak apa yang perlu ia baca. Sampai 0.8.35 perintah mengabaikan kiriman itu dan
langkah agent pertama yang membacanya.

Automation seperti ini dibuat admin dari dashboard: panggilan dari luar yang menjalankan perintah tanpa model di
antaranya bukan hal yang diusulkan agent.

### Supaya webhook bisa dipanggil dari internet

GitHub, Stripe dan sejenisnya memanggil webhook dari internet. Kebanyakan box ada di balik router
rumah, dan panggilan itu gak pernah sampai kecuali ada yang membukakan jalan. Halaman webhook itu
sendiri menyebutkan keadaannya:

| | |
|---|---|
| **Local network only** | Belum ada alamat publik (`[dashboard] public_url`), atau alamat yang diisi ada di jaringan ini: alamat `192.168.…`, nama `.local` atau `.lan`, nama tanpa titik. Hanya perangkat di jaringan ini yang bisa memanggilnya |
| **Reachable from the internet** | Tes yang dikirim lewat alamat publik sampai ke daemon |
| **Reach unknown** | Alamat publik sudah diisi, tapi belum ada tes lewat alamat itu yang sampai: belum pernah dikirim, atau tes terakhir gak sampai |

**Send a test** (`nouride webhook test <id>`) mengirim request ke webhook lewat alamat publiknya,
ditandai sebagai tes. Daemon menghitungnya waktu sampai dan gak menjalankan job-nya. Kartunya lalu
menyebutkan berapa lama tesnya, atau apa yang terjadi: namanya gak bisa di-resolve, koneksinya
ditolak, atau ada server lain yang menjawab di alamat itu.

Untuk memberi box alamat publik, pilih salah satu:

- jalankan **tunnel**, misalnya Cloudflare Tunnel atau Tailscale Funnel. Box yang membuka koneksi
  keluar, jadi gak ada yang diubah di router. Isi `public_url` dengan alamat dari tunnel itu; atau
- **forward port** di router ke port box (18254), sebaiknya lewat reverse proxy yang melayani HTTPS.

Tes lewat port yang di-forward bisa gagal dari box itu sendiri padahal panggilan dari luar sampai:
banyak router gak meneruskan request dari dalam kembali lewat alamat publiknya sendiri. Panggilan dari
luar yang memastikannya. Tunnel gak punya masalah ini.

Nama yang gak bisa di-resolve dari box itu lain soal: kemungkinan besar internet juga gak bisa menemukannya. Nama
yang cuma dikenal DNS router atau Tailscale bisa dipakai di rumah, tapi gak di tempat lain. Beri nama itu record DNS
publik, atau pakai alamat dari tunnel.

Chat sudah bisa menjangkau box dari mana saja, karena Telegram, Discord dan WhatsApp adalah koneksi
yang dibuka box ke luar. Apa pun yang bisa mengirim pesan ke salah satunya bisa memulai agent tanpa
webhook.

## Morning line

Begitu kerja jalan sendiri, perlu ada cara tahu apa yang terjadi tanpa membuka dashboard. **Morning
line** adalah satu pesan sehari, di jam yang diatur seseorang, ke chat orang itu sendiri:

```
☀ Since yesterday morning

Needs you · 1
• nox asks to run exec

Scheduled runs failed · 1
• Customer mail (the provider was down)

Missions done · 2
• Sum up the mail
• Check the backups

Spent in the last day · $1.20
• nouva on gpt-5: $0.80
• nox on qwen3: $0.40
```

Mati untuk semua orang sampai dinyalakan: halaman People punya sakelar per orang, yang mulai di jam
07:00 dan bisa diubah ke jam berapa pun, menurut `[daemon] timezone`. Di berkasnya,
`people/<key>.toml`, ditulis `morning = "07:00"`. Pesannya ditulis daemon dari catatannya sendiri, jadi gak makan token.
Isinya mencakup run terjadwal yang gagal, approval dan mission yang menunggu orang itu, dan mission
yang selesai atau berakhir, semuanya dari sehari terakhir. Tiap orang hanya diberi tahu soal chat-nya
sendiri, job yang ia nyalakan, dan mission yang ia mulai; admin diberi tahu semuanya, plus biayanya.
**Pagi yang sepi gak mengirim apa-apa**, jadi kalau gak ada pesan berarti semuanya jalan. Pesannya
dikirim ke tempat yang dipilih di sebelah jamnya di halaman People: salah satu akun Telegram, Discord
atau WhatsApp orang itu (`morning_to = "telegram:555"`). Kalau belum dipilih, ke akun tempat ia terakhir
menulis; kalau koneksinya mati, ke akun berikutnya yang nyala. Pesan yang jatuh tempo saat daemon
mati tetap dikirim kalau masih dalam satu jam setelah jamnya; lewat dari itu, hari itu dilewati.

## Pagar pengaman

Ini ada karena model yang bisa membuat job bisa membuatnya dalam loop. Semuanya di `[cron]`, kecuali
`job_wake_max_chain`, yang ada di `[agents]`.

| | |
|---|---|
| `min_interval_ms` (60 dtk) | batas bawah jadwal berulang. Bedanya agent menjadwalkan pemeriksaan dan agent menjadwalkan loop panggilan provider |
| `max_jobs` (100) | untuk semua agent |
| `fail_streak_limit` (10) | kegagalan berturut-turut sebelum sebuah job menonaktifkan dirinya dan menjelaskan sebabnya. `nouride cron enable <id>` membersihkannya |
| `catchup_window_ms` (1 jam) | seberapa terlambat sebuah job masih boleh menyala saat daemon kembali. Di luar itu, job berulang pindah ke jadwal berikutnya dan job sekali-jalan dicatat terlewat, daemon yang mati tiga hari gak boleh kembali dengan tiga hari pengingat |
| `run_retention_days` (3) | berapa lama riwayat run disimpan |
| `command_timeout_ms` (10 mnt) | batas waktu untuk payload `--command` |
| `job_wake_max_chain` (100) | berapa kali background job yang selesai boleh membangunkan agent tanpa ada manusia bicara di antaranya |

**Dua run yang bukan kegagalan.** Job yang bekerja di percakapan chat itu sendiri (`--session chat`)
dan mengirim hasilnya diam-diam atau ke webhook gak dijalankan menimpa giliran seseorang di sana: run-nya
dicatat `skipped` (`agent busy: …`) dan jadwal berikutnya datang seperti biasa. Job yang mengumumkan
hasilnya di chat dikirim sebagai pesan, dan menunggu di belakang giliran itu. Run yang terpotong restart dicatat `interrupted`. Keduanya gak dilaporkan
ke chat dan gak dihitung ke `fail_streak_limit`. Giliran agent juga menunggu slot di bawah
`[queue] max_concurrent_turns`, seperti giliran chat, bukan berjalan di luar batas itu. Run yang jatuh tempo saat
agent-nya tidur juga dicatat `skipped` (`agent asleep: …`), apa pun yang dijalankan job itu, termasuk perintah.

Yang terakhir layak satu kalimat. Job yang selesai membangunkan agent-nya, giliran itu sering memulai
langkah berikutnya, dan penyelesaiannya membangunkannya lagi, rantai tanpa manusia di dalamnya, setiap
lompatannya satu panggilan provider. Angkanya sengaja tinggi: instalasi sembilan langkah adalah sembilan
job, dan rantai itu sah. Saat batas tercapai, pembangunannya tetap dikirim dan agent diminta melaporkan
hasil lalu gak memulai apa pun lagi; menekannya justru akan menyembunyikan persis kegagalan yang
ingin dijaga. Pesan apa pun dari manusia mereset hitungannya.

Run yang terpotong restart ditandai interrupted di riwayatnya. Job berulang lanjut di jadwal
berikutnya. Job sekali-jalan mungkin sudah jalan sebagian, jadi ia dijeda alih-alih dinyalakan lagi
sendiri; `nouride cron run <id>` mencobanya lagi.

## Approval jam 3 pagi

Giliran terjadwal gak punya orang untuk ditanya, jadi `[cron] unattended_approval` yang memutuskan.
Pada default-nya, `auto`, run-nya diperlakukan sebagai `balanced`: panggilan biasa langsung jalan, karena
job yang berhenti di prompt yang gak akan dilihat siapa pun sama saja dengan gak jalan. `deny`
memperlakukannya sebagai `careful` dan menolak apa pun yang seharusnya bertanya, supaya job-nya gagal
dengan jujur.

Bagaimanapun, yang gak pernah dijawab `balanced`, penghapusan, service yang dimatikan, infrastruktur, path
kredensial, session interaktif, langsung ditolak di tempat alih-alih dibiarkan menunggu jawaban yang gak
mungkin datang,
dan agent bilang apa yang gak bisa dikerjakannya. [Approval →](/id/docs/manual/approvals/)

## Background job itu hal lain

`nouride jobs` mendaftar pekerjaan yang dimulai agent *saat* sebuah giliran, build panjang, script
lambat, atau server yang dijalankannya lewat opsi `service` di `exec` (dev server, tunnel), bukan
sesuatu yang terjadwal.

```bash
nouride jobs
nouride jobs log <id>
nouride jobs kill <id>
```

Memulai background job biasanya mengakhiri giliran agent, dan job itu membangunkannya dengan hasilnya
saat selesai, dan itulah rantai yang dibatasi `job_wake_max_chain`. Dengan `keep_working`, agent
melanjutkan pekerjaan lain yang gak butuh hasil itu, misalnya membetulkan file lain selama build jalan,
dan baru mendengar hasilnya setelah giliran itu. Kalau langkah berikutnya butuh hasilnya, ia tetap
menunggu.

Job yang gak mencetak apa pun untuk sementara gak dihentikan. Setelah `[jobs] quiet_after_minutes` (5)
agent-nya memberi tahu orangnya bahwa job itu masih jalan, lalu lagi setelah dua kali lipat waktunya.
Diatur di **Agents → Settings**, dan per agent di tab *Settings*-nya sendiri.

Job yang jalan terlalu lama bisa dihentikan. `[security] job_max_ms` (mati kecuali diisi)
menghentikan job yang masih jalan setelah sekian milidetik, dan agent-nya memberi tahu orangnya bahwa
job itu gak selesai. Service dikecualikan.
