---
title: Memori
description: "Cara agent mengingat: percakapan diarsipkan tiap malam ke Markdown, apa yang dipelajari tentang orang, siapa boleh membaca apa, dan cara recall bekerja tanpa model tambahan."
---

Memori dibangun agar tetap cukup kecil untuk Raspberry Pi dan tetap terasa seperti asisten yang
mengenal kamu. Empat gagasan menopangnya:

- **File adalah sumber kebenaran.** Semua yang diingat berupa Markdown di satu folder: buka di
  Obsidian, sunting dengan tangan, backup dengan `cp`. Indeks SQLite di sebelahnya boleh dihapus dan
  dibangun ulang.
- **Kerjanya terjadi di malam hari.** Satu giliran chat hanya membaca memori. Meringkas dan belajar
  adalah satu panggilan model per percakapan, sekali semalam.
- **Siapa yang boleh membaca sesuatu diputuskan di kode**, dari siapa yang ada di percakapan asalnya.
  Model gak pernah memutuskannya.
- **Gak butuh model tambahan.** Pencarian kata kunci selalu jalan; pencarian semantik opsional.

```
 chats ──► turn log ──► cut ──► episode (raw)  ──► nightly pass ──► episode (summarized)
                                                        │                 │
                                                        ├─► facts ──► people/<key>.md
                                                        └─► proposals ─► shared.md (after approval)

 every turn ◄── recall: profile · the week ahead · follow-ups · recent summaries
 on request ◄── memory_search · memory_read · memory_analyze
```

## Vault-nya

Satu folder, `[memory] dir` (default `.nouride/memory`):

```
memory/
├── episodes/2026/09/2026-09-25-0459-nouva.md   satu percakapan
├── days/2026/09/2026-09-25.md                  hub satu hari, untuk navigasi
├── people/alex.md                              yang diketahui tentang seseorang
├── shared.md                                   yang diketahui semua agent
├── agents/  groups/  tags/                     stub kecil, supaya graph punya nama; tag mendapatkannya begitu dua percakapan memakainya
├── tags/_tidy/                                 catatan tiap kali tag dirapikan, yang dibaca tombol Undo
└── archive/2026/09/…md.gz                      transkrip lama, terkompresi, tak terbaca agent
```

Tautan tinggal di frontmatter (`day`, `agents`, `people`, `tags`, `related`), jadi graph Obsidian
menampilkan orang dan agent sebagai hub, episode di sekelilingnya, dan tag yang menyambungkan episode
dengan satu topik. Episode, hub hari dan transkrip arsip disusun per tahun dan bulan, jadi gak ada
folder yang tumbuh melebihi percakapan sebulan.

`MEMORY.md` milik agent sendiri di persona pack-nya terpisah: catatan kerjanya, ditulis agent itu
dengan `memory_write`, hanya dibaca agent itu, dan gak pernah disentuh nightly pass.

Tiap jenis hal punya satu tempat, dan agent diberi tahu yang mana:

| Apa | Di mana | Ditulis oleh |
|---|---|---|
| Siapa seseorang, dan yang tidak berubah: dipanggil apa, siapa dia bagi rumah tangga, ulang tahun, alergi | **Notes**-nya di People | Kamu, untuk siapa saja. Lewat agent, orang hanya bisa mengubah notes-nya sendiri, per baris (`person_notes`) |
| Yang dipelajari tentang dia dan bisa berubah: kerja, selera, rencana | Profilnya, `people/<key>.md` | Nightly pass, dan `memory_write` dengan `about=person` |
| Yang perlu diketahui semua agent | `shared.md` | Nightly pass, lewat Proposals |
| Cara kerja agent, dan apa yang sedang dia kerjakan | `MEMORY.md` miliknya sendiri | Agent itu, dengan `memory_write` |

## Episode

Sebuah **episode** adalah satu rentang dari satu chat. Chat dipotong menjadi episode hanya di dua
momen: `/new` atau `/reset` di chat itu, dan nightly pass, yang memotong tiap chat yang aktif sejak
potongan terakhirnya. Gak ada timer idle. Rentang yang melewati tengah malam dipecah per hari, dan
yang terlalu panjang untuk satu panggilan model dipecah di batas giliran.

Episode dibangun dari turn log daemon dan log pesan ruangannya, bukan dari konteks percakapan, jadi
compaction dan `/new` gak menghilangkan apa pun. Group chat dengan beberapa bot adalah satu episode
yang menyebut semuanya. Episode butuh setidaknya satu giliran agent: orang yang mengobrol di antara
mereka sendiri bukan memori, dan obrolan lebih dari sehari sebelum balasan agent gak ikut membuka
episodenya.

Tiap episode melewati tiga state:

| State | Isinya |
|---|---|
| `raw` | Sudah dipotong, beserta transkripnya. Sudah bisa dicari lewat kata-katanya. |
| `summarized` | Nightly pass menambahkan ringkasan, hingga empat tag, tingkat kepentingan 1 sampai 5, orang-orang yang dibicarakan, dan hingga tiga episode terkait. |
| `compacted` | Setelah `transcript_days` (180; `0` menyimpannya selamanya) transkrip keluar dari episode. Ringkasan tetap selamanya; dengan `archive` menyala, transkrip disimpan terkompresi di bawah `archive/`. |

## Nightly pass

Pada `pass_at` (01:00 secara default) pass memotong tiap chat yang terbuka, lalu membuat satu
panggilan model per episode raw, paling banyak `pass_per_night` per agent, pesan langsung duluan.
Model diperlihatkan transkrip yang sudah diredaksi, fakta para peserta yang boleh dilihat percakapan
ini, tag yang sudah dipakai, dan rubrik kepentingan yang tetap. Jawabannya JSON, diperiksa per field;
apa pun yang salah dibuang beserta alasannya alih-alih menggagalkan seluruh episode. Episode yang
gagal `max_attempts` kali menunggu di Timeline untuk ditangani orang.

Memori ditulis dalam bahasa Inggris apa pun bahasa yang dipakai (ringkasan, fakta, catatan dan tag),
supaya satu kata kunci menemukannya di semua chat. Nama dan istilah yang dikutip tetap seperti
diucapkan, dan transkrip tetap seperti apa yang dikatakan. Setiap penulis memeriksanya: jawaban pass
yang bukan bahasa Inggris diminta sekali lagi, dan dibiarkan raw untuk malam berikutnya kalau masih
bukan; `memory_write` menolaknya; perapian profil atau forget yang kembali dalam bahasa lain gak
disimpan.

Setelah panggilan itu: file episode ditulis ulang, fakta diterapkan ke profil, indeks diperbarui,
ringkasan baru di-embed kalau pencarian semantik menyala, transkrip lama di-compact, dan hub hari yang
berubah digambar ulang. Profil yang sudah melewati 40 fakta atau 3.000 karakter dirapikan (duplikat
digabung, yang sudah gak benar dibuang), tiga per malam.

Kalau mesinnya lagi sibuk, pass malam menunggu (0.8.0). Sibuk artinya salah satu dari tiga hal: CPU
terpakai lebih dari 70% selama semenit terakhir, sebuah thermal zone sudah di atau melewati trip point
tempat kernel bertindak atas panasnya (memperlambat CPU, atau mematikan mesin; trip point untuk kipas
gak dihitung), atau cgroup daemon menunggu memori 10% atau lebih dari semenit terakhir. Selama itu pass melewati menit tersebut; kalau sudah jalan, ia menunggu sebelum tiap
percakapan dan tiap batch embedding, dan mengecek lagi tiap setengah menit. Setelah menunggu dua jam
total, ia tetap jalan. Log mencatat sekali bahwa ia menunggu, beserta alasannya, dan sekali saat ia
lanjut. Mesin yang gak punya file-file ini (Mac misalnya) gak pernah dianggap sibuk. Run now dan
`nouride memory pass` gak pernah menunggu.

### Tag

Sebuah tag berguna ketika banyak percakapan memakainya: itulah yang membentuk klaster di graph dan
membuat hitungan bermakna. Jadi pass menjaga satu kosakata, dengan cara yang sama untuk setiap
instalasi dan setiap bahasa:

- **Model diperlihatkan tag yang sudah dipakai** di audiens percakapan itu, yang paling sering dulu,
  lalu yang dipakai sekali dalam 30 hari terakhir (paling banyak sekitar 1.000 token), serta tag
  terbaru chat itu sendiri.
- **Setiap tag melewati satu gerbang.** Ejaan baru dilipat ke tag yang sudah dipakai kalau cocoknya
  pasti: bentuk jamak atau pemisah (`reminders` → `reminder`), salah ketik satu huruf dari tag yang ada
  di tiga percakapan atau lebih, atau bentuk pendek yang diperpanjang akhiran bahasa Inggris (`blog` →
  `blogging`). Setelah itu satu percakapan boleh membuat **satu** tag baru (tiga selama audiensnya
  punya kurang dari 20 percakapan bertag) dan menyimpan paling banyak empat tag, gak pernah nol.
- **Paginya**, halaman Knowledge & Memory di dashboard menampilkan tag yang dibuat malam itu, masing-masing dengan
  tag lama yang dinilai model paling dekat, dan **Merge into** ke tag itu dengan satu klik.

Yang sudah tertulis sebelumnya dirapikan dengan cara yang sama, saat diminta: **Tidy tags** di halaman
Memory (atau `nouride memory tags tidy`) menampilkan pratinjau penggabungan menurut aturan yang sama,
tag yang lebih spesifik dilipat ke tag umum di sampingnya (`architecture-review` → `architecture`;
ditawarkan tanpa centang, karena tag yang lebih spesifik bisa jadi topik tersendiri),
tag sekali-pakai dipangkas (percakapan menyimpan satu, hari hasil impor gak ada), dan batas empat
tag. Orang mencentang apa yang diterapkan; model hanya ditanya soal penggabungan berdasarkan makna
kalau itu juga dicentang. Penerapannya hanya menulis ulang baris `tags:` tiap percakapan, menyimpan
nama yang digabung sebagai alias tag yang dipertahankan (jadi malam berikutnya melipatnya), mem-backup
vault lebih dulu dan mencatat perubahan di `tags/_tidy/`, yang dibaca oleh **Undo**. Catatan itu
menyebut percakapan lewat id dan stub lewat nama tag, dan Undo menolak catatan yang menyebut hal lain:
catatan itu ada di vault yang disinkronkan dan diedit tangan, dan Undo menulis apa yang disebutnya.
Graph punya **Merge into…** di setiap tag.

## Fakta

Profil adalah fakta di bawah heading. Tiap baris menyebut asalnya dan siapa yang boleh membacanya:

```markdown
## Devices
- Uses a MacBook Air M1 laptop ([[2026-09-29-0739-ren]]) {alex}

## Plans
- Vacation in Lombok (until 2026-10-09) ([[2026-09-29-0739-ren]]) {alex}

## Family
- Mother's birthday (on --10-02) ([[2026-09-29-0739-ren-2]]) {alex}

## Follow-ups
- Pay the electricity bill (on 2026-09-30) ([[2026-09-29-0739-ren-2]]) {alex}
```

- `{…}` adalah audiens percakapan asalnya: siapa yang ikut, dan grupnya kalau itu grup. File itu
  sendiri yang menentukan siapa boleh membaca fakta tersebut, bahkan setelah episodenya di-compact atau
  dihapus.
- **Tanggal adalah bagian dari kata-katanya.** `(until …)`: begitu harinya lewat, fakta itu gak
  ditampilkan atau ditemukan lagi. `(on YYYY-MM-DD)` adalah satu hari; `(on --MM-DD)` kembali tiap
  tahun. Keduanya muncul di prompt seminggu sebelumnya.
- **Follow-ups** adalah hal yang seseorang bilang akan dikerjakan nanti, atau minta diingatkan.
  Semuanya didaftar tersendiri di prompt, dan dihapus ketika percakapan berikutnya (atau agent, lewat
  `memory_write`) menyatakannya selesai.

Apakah fakta dipelajari adalah pilihan: `facts` bernilai `off`, `ask` (tiap perubahan menjadi
Proposal) atau `auto` (langsung diterapkan), untuk semua orang, dan bisa ditimpa per orang di tab
People. Pengetahuan bersama dibaca di setiap chat, jadi ia hanya pernah diusulkan, gak pernah
langsung diterapkan, dan hanya dengan `propose_shared`.

Setiap perubahan (oleh pass, perapian, agent, atau proposal yang disetujui) dicatat beserta apa yang
digantikannya dan alasannya, dan ditampilkan sebagai Recent changes. Tiap profil menyimpan versi
sebelumnya: tinggal satu undo.

## Siapa melihat apa

| Di mana agent sedang bicara | Percakapan yang boleh diingatnya |
|---|---|
| DM dengan seseorang | Yang diikuti orang itu, di agent mana pun: DM-nya dan grup-grupnya |
| Sebuah grup | Milik grup itu sendiri |
| Token MCP untuk seseorang | Seperti DM dengan orang itu, dibatasi ke agent yang disebut token tersebut |

Sebuah fakta bisa dibaca tepat di tempat percakapan asalnya bisa dibaca: di DM dengan seseorang di
daftar `{…}`-nya, atau di grup yang disebutnya. Yang Sam ceritakan ke agent secara pribadi sampai ke
DM Sam dan gak ke mana pun lagi; gak pernah muncul di grup keluarga, dan gak pernah di DM orang
lain. Menghapus episode menghapus fakta yang diajarkannya.

## Recall

**Di setiap prompt**, sudah difilter oleh aturan di atas, dan stabil di antara potongan supaya tetap
berada di bagian prompt yang di-cache:

- profil tiap orang yang dikenal di chat itu, hingga 60 fakta per orang dan 120 total, jadi di grup
  besar yang sedang bicara tampil penuh dan yang lain berbagi sisanya;
- `shared.md`;
- apa yang akan datang dalam seminggu ke depan, dan follow-up yang masih terbuka;
- ringkasan terbaru yang boleh dilihat chat ini (`prompt_recent`, 3), masing-masing menyebut kalau itu
  milik agent lain;
- percakapan yang dipotong sejak pass terakhir (setelah `/new`, yang barusan ditinggalkan) lewat
  baris pertamanya.

`recall = false` di `[memory]` mengeluarkan semuanya dari prompt, dan `recall` milik satu entri `[[people]]` menimpanya
untuk orang itu (di dashboard: Knowledge & Memory → Settings, dan tiap orang di tab People). Saat mati, nightly pass tetap belajar dan
agent tetap bisa membuka memori lewat tool di bawah.

**Saat diminta**, lewat tool:

| Tool | Fungsinya |
|---|---|
| `memory_search` | Mencari percakapan dan fakta yang boleh dilihat chat ini. |
| `memory_read` | Membuka satu percakapan: transkripnya selama masih disimpan, kalau gak ringkasannya. Dengan `related`, juga percakapan di sebelahnya. |
| `memory_analyze` | Hitungan, bukan prosa: tanggal sesuatu muncul, per hari/minggu/bulan, tag atau orang teratas, aktivitas per agent, tingkat kepentingan. Tanpa panggilan model. |
| `memory_write` | `MEMORY.md` milik agent sendiri, atau (`about=person`) menambah, mengoreksi atau membuang fakta tentang orang yang sedang diajaknya bicara. |

### Cara pencarian mengurutkan

1. **Filter dulu** ke apa yang boleh dilihat chat ini.
2. **Kata kunci:** BM25 atas indeks term dari ringkasan, tag, fakta dan transkrip yang masih disimpan.
   Kata query dengan empat huruf atau lebih juga cocok dengan kata-kata yang diawalinya; bentuk jamak
   bahasa Inggris dipotong; akar kata yang tersembunyi di balik imbuhan bahasa Indonesia diindeks di
   samping tiap kata, jadi `liburan` menemukan `berlibur`.
3. **Makna**, kalau pencarian semantik menyala: cosine atas vektor int8 dari item yang sama, digabung
   dengan peringkat kata kunci (RRF). Tiga teratas peringkat kata kunci tetap mendapat bonus, jadi hit
   yang persis (alamat, port, nama) gak tergeser oleh sesuatu yang sekadar mirip.
4. **Skor:** relevansi 0,5, kepentingan 0,3, kebaruan 0,2.
5. **Dua lompatan** lewat `related`, ke dua arah, dengan 0,7 dari skor per lompatan, paling banyak lima per hasil.

Episode terkait dipilih oleh pass dari 90 hari terakhir: yang berbagi satu orang dan satu tag, tiga
yang terdekat, diurutkan ulang menurut kemiripan ringkasannya kalau pencarian semantik menyala.

### Kenapa dua hal ini

**Mengikuti satu urusan.** Satu urusan sering berupa beberapa percakapan di hari yang berbeda: Senin
"NAS-nya penuh", Rabu "sekarang lambat", Jumat "disk-nya sudah diganti". Pencarian menemukan salah
satunya; `related` membuat yang lain ikut terbawa tanpa agent harus menebak kata lain: langkah satu
lompatan melakukannya di setiap pencarian, dan `memory_read` dengan `related` melakukannya dengan
sengaja: untuk "lanjutkan yang kemarin", untuk masalah yang kambuh ("dulu kita benerinnya gimana?"),
dan untuk percakapan panjang yang terpotong di tengah malam. Ini ide `build_context` dari Basic Memory,
dibatasi pada tautan yang sudah ada di indeks: tanpa model, tanpa database graph, dan setiap tetangga
melewati aturan yang sama dengan percakapan mana pun.

**Yang persis mengalahkan yang mirip.** Pencarian makna jago untuk "yang kira-kira begini" dan lemah
untuk "persis ini". Saat ditanya "port Postgres staging 5433" atau "192.168.0.54", embedding bisa
menganggap percakapan soal database secara umum lebih dekat daripada percakapan yang benar-benar
menyebut 5433. Bonus untuk tiga teratas peringkat kata kunci (ide position-aware blending dari QMD)
menjaga hit yang persis tetap di atas. Kalau pencarian semantik mati, yang ada hanya peringkat kata
kunci, jadi gak ada yang perlu dilindungi.

Pencarian semantik butuh provider yang melayani embedding lewat API OpenAI: Ollama di jaringan kamu
sendiri (`bge-m3`), OpenAI (`text-embedding-3-small`) atau Gemini (`gemini-embedding-001`). Vektor
disimpan di indeks dan dicari secara brute force, yang masih wajar sampai puluhan ribu percakapan di
hardware kecil. Embed yang gagal jatuh kembali ke kata kunci, gak pernah ke error.

## Di dashboard

### Halaman Knowledge & Memory

**Memory** di menu membukanya. Baris paling atas menunjukkan apakah memori menyala, kapan nightly pass
berikutnya jalan, dan apakah pencarian berdasarkan makna aktif; di bawahnya, tag tidy terakhir,
lengkap dengan **Undo**.

![Halaman Memory, di tab Agent notes](/media/memory-page.png)

| Tab | Isinya |
|---|---|
| **Agent notes** | `MEMORY.md` milik tiap agent, yang dia simpan sendiri lewat `memory_write`. Gak pernah diubah nightly pass. Bisa dibuka untuk dibaca atau diedit; simpanan di atas versi yang keburu diubah agent ditolak, bukan menimpanya. |
| **People** | Semua orang yang punya profil: fakta mereka, dari mana tiap fakta berasal dan siapa yang boleh membacanya, apakah fakta dipelajari untuk mereka (`off`, `ask`, `auto`), versi lama profilnya, dan **Forget**. **Notes** membuka notes mereka dari People, teks dan dialog yang sama. |
| **Timeline** | Percakapan per hari, yang terbaru dulu, dengan ringkasan, tag, orang, dan tingkat pentingnya, plus yang gagal diproses pass, untuk dicoba ulang. |
| **Shared** | `shared.md`, yang diketahui semua agent. |
| **Proposals** | Perubahan yang menunggu persetujuan orang: fakta selama `facts = "ask"`, dan apa pun untuk `shared.md`. |
| **Settings** | Nightly pass, helper model (model milik pass, yang juga meringkas percakapan panjang) dan apakah ia jalan, berapa ringkasan terbaru yang dibawa tiap prompt, dan pencarian berdasarkan makna. |

**Tidy tags** dan **Graph view** membuka dua alat yang dijelaskan di [Tag](#tag) dan di bawah ini.

### Memory graph

**Graph view** menggambar isi memori: setiap percakapan adalah satu titik, tersambung ke apa pun yang
ditautkannya.

![Memory graph](/media/memory-graph.png)

| Titik | Apa itu | Ukurannya |
|---|---|---|
| Percakapan | Satu episode, berlabel baris pertama ringkasannya | tingkat pentingnya |
| Orang | Seseorang yang ikut dalam percakapan itu, atau yang dibicarakan | berapa percakapan yang tampil tertaut ke dia |
| Tag | Sebuah topik | sama |
| Agent | Agent yang diajak bicara | sama |

Percakapan tersambung ke agent-nya, ke orang-orang di dalamnya (garis putus-putus kalau mereka cuma
dibicarakan), ke tag-nya, dan ke percakapan yang dinilai **related** oleh nightly pass. Sambungan
titik-ke-titik yang terakhir inilah yang diikuti pencarian saat membawa percakapan tetangganya.

Graph ini dibuat supaya cepat terbuka bahkan di Pi, dan itu membentuk apa yang kamu lihat:

- **300 percakapan terbaru** yang cocok dengan filter (bisa dipilih 150, 600, atau 1.000), gak
  pernah seluruh vault.
- **Tag yang cuma ada di satu percakapan yang tampil gak digambar.** Tag itu gak menyambungkan
  apa pun, dan di vault sungguhan tiga dari empat tag seperti itu.
- **Dibangun sekali tiap memori berubah**, praktisnya sekali semalam setelah pass, seberapa sering
  pun dibuka.
- **Percakapan, dan dokumen kalau diminta.** Tombol **Documents** menampilkan knowledge base di atasnya: tiap
  koleksi dan dokumennya, link di antara dokumen, orang yang menjadi topik sebuah koleksi, dokumen yang maknanya
  dekat, garis dari tiap percakapan ke dokumen yang dibukanya, dan dari tiap dokumen ke tag dari frontmatter-nya,
  satu titik dengan tag percakapan yang bernama sama. Fakta ada di profil, di tab People.

Cara membacanya: tag yang dikelilingi banyak titik adalah topik yang terus muncul; rantai pendek
percakapan yang tersambung langsung adalah satu urusan selama beberapa hari; orang atau agent dengan
awan titik di sekitarnya adalah semua yang pernah melibatkan mereka.

Cara memakainya:

- **Filter** berdasarkan agent, orang, tag, dan rentang waktu. Beberapa pilihan dari satu jenis
  cocok dengan salah satunya; jenis yang berbeda harus cocok semua: "Nouva atau Ren, dan `#homelab`".
- Legend menampilkan atau menyembunyikan satu jenis titik; kotak pencarian menyorot titik yang
  labelnya cocok.
- **Klik satu titik**, sambungannya menyala dan sebuah panel terbuka. Di percakapan, **Read
  conversation** membukanya (ringkasan, tag, orang, dan transkrip selama masih disimpan), dengan
  daftar percakapan terkaitnya di bawah. Di orang, tag, atau agent, panel menampilkan percakapan
  yang memuatnya, dan **Only this** menyaring graph ke percakapan itu saja.
- **Tag bisa digabung** dari panelnya lewat **Merge into…**: penggabungan yang sama dengan **Tidy
  tags**: vault di-backup dulu, nama lama disimpan sebagai alias supaya malam berikutnya ikut
  dilipat, dan baris tidy di halaman Knowledge & Memory bisa membatalkannya.

![Satu tag dipilih, dengan Merge into…](/media/memory-graph-tag.png)

Seret untuk menggeser, scroll untuk zoom; setiap percakapan diberi label begitu kamu zoom in.
Sambungan yang sama juga ditulis di frontmatter tiap file, jadi graph view Obsidian menggambar
gambaran yang sama dari vault.

## Indeksnya

Tabel SQLite di samping state daemon lainnya (episode, orang-orangnya, tag dan tautan related, fakta
beserta pembacanya, indeks term, vektor): semuanya dibangun ulang dari vault oleh `nouride memory
reindex`. File dibaca ulang saat boot dan sebelum tiap pass kalau waktu modifikasi atau ukurannya
berubah, jadi suntingan di Obsidian atau tool sinkronisasi ikut terbaca. Hanya SQL portabel: tanpa
ekstensi full-text, tanpa ekstensi vektor.

## Knowledge base

Dokumen yang disimpan seseorang sebagai rujukan (SOP, manual, kebijakan) bukan memory: dokumen disimpan utuh dalam koleksi
di `.nouride/knowledge/`, tidak pernah dirangkum dan tidak pernah dijadikan fakta. Bagian-bagiannya ada di indeks kata
dan vektor yang sama dengan memory, jadi `memory_search` memeringkatnya bersama percakapan dan fakta, disaring dengan
aturan yang sama: sebuah koleksi hanya dicari kalau setiap orang di percakapan boleh dijawab darinya. RECALL menyebut
koleksi yang boleh dicari agent di sana, bukan dokumennya. Halaman [knowledge base](/id/docs/manual/knowledge/)
menjelaskan cara menyimpannya.

## Menjaganya tetap aman

- **Backup:** vault di-snapshot mingguan ke `data/backups/memory/<stamp>/`, pohon lengkap (restore cukup
  `cp -r`). File yang gak berubah di-hard-link ke snapshot sebelumnya, jadi sebulan snapshot kira-kira
  seharga satu vault. `daemon.backup_keep` menentukan berapa banyak.
- **Melupakan seseorang:** *forget completely* menghapus profilnya, percakapan yang diikutinya dan
  proposal tentangnya, lalu menulis ulang ringkasan lain tanpa dirinya (diperiksa sesudahnya untuk
  namanya); *hide their name* menggantinya dengan `[forgotten]`. Keduanya gak bisa dibatalkan: versi
  lama setiap profil kehilangan apa yang diajarkan percakapannya, begitu juga Recent changes. Semua chat
  dipotong dulu, jadi yang dia katakan sejak potongan terakhir ikut hilang. Snapshot mingguan di atas tetap
  menyimpannya sampai dirotasi keluar, chat yang masih terbuka dengannya sampai `/new`, dan log turn
  selama `session_days`.
- **Secret gak pernah sampai ke memori:** transkrip diredaksi sebelum dilihat model, dan pass diberi
  instruksi untuk gak pernah menulis kredensial, kode atau alamat.

## Pengaturan

```toml
[memory]
dir             = "./.nouride/memory"
pass            = false       # the nightly pass; the setup wizard asks
pass_at         = "01:00"
pass_per_night  = 20          # episodes per agent per night
pass_provider   = ""          # kosong: provider dan model milik tiap agent
pass_model      = ""
max_attempts    = 3
facts           = "off"       # off | ask | auto; per orang di tab People
propose_shared  = false
prompt_recent   = 3
recall          = true          # yang diingat, masuk ke tiap prompt
transcript_days = 180         # 0 = forever
archive         = true

[memory.semantic]
enabled    = false
provider   = ""               # an OpenAI-compatible profile that embeds, e.g. one pointing at Ollama
model      = ""               # e.g. bge-m3
dimensions = 512
```

`pass_provider` dan `pass_model` adalah **helper model**. Ia menulis ringkasan nightly pass, dan juga
meringkas percakapan yang sudah terlalu panjang untuk dibawa utuh oleh agent-nya (compaction), kecuali
`[llm.context] summary_model` diisi; kalau begitu percakapan panjang diringkas dengan model itu, di provider
milik tiap agent. Kalau helper model gak bisa menjawab (gak tersedia, gak punya akses, kuota habis), model
milik tiap agent yang ditanya sebagai gantinya. Apakah ia jalan ditampilkan di bawahnya, di kartu **Helper
model** di Knowledge & Memory → Settings: *Working* kalau gak ada yang sedang gagal, kalau tidak: apa yang gagal
(meringkas, nightly pass, atau model yang digantikan model milik tiap agent), berapa kali, sudah berapa lama,
dan error terakhir dari provider. Peringatan hilang begitu pekerjaannya jalan lagi atau modelnya sudah gak
dipakai, paling lambat sehari setelah kegagalan terakhir. `nouride doctor` dan peringatan di Home
mengatakan hal yang sama.

Sebuah vektor disimpan menurut provider, model, dan ukuran yang diminta darinya, jadi mengganti salah
satu dari ketiganya membuat semuanya di-embed ulang, sebagian tiap malam. Sampai saat itu vektor lama
tetap di tempatnya: masing-masing diganti ketika percakapan atau fakta-nya di-embed ulang, jadi model
yang gak bisa dihubungi, atau model yang kamu ganti lalu kembalikan, membiarkan pencarian berdasarkan
makna seperti semula.

Nouride juga bisa menyajikan memori ke tool lain sebagai server MCP: mencari dan membaca sebagai
seseorang, dan menyimpan percakapan dari tempat lain untuk diarsipkan malam ini. Lihat
**Integrations** di dashboard.

![Integrations: server MCP Nouride, dan satu key per aplikasi](/media/dashboard-integrations.png)
