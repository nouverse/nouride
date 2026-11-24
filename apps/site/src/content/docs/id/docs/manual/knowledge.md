---
title: Knowledge base
description: "Dokumen yang Anda simpan untuk dicari agent: koleksi, siapa yang boleh dijawab darinya, dan bagaimana agent menemukan serta menyebut sumbernya."
---

Memory belajar dari percakapan Anda. Knowledge base untuk hal yang tidak pernah dibicarakan di chat: manual, SOP, daftar
harga, kebijakan, hasil lab. Anda yang menyimpan dokumennya; agent mencarinya saat pertanyaan menyangkut isinya, dan
menyebut dokumen serta bagian mana jawaban itu berasal.

## Koleksi

Dokumen disimpan dalam **koleksi**, masing-masing satu folder. Buat lewat dashboard di **Knowledge & Memory →
Knowledge → Koleksi baru**, atau minta agent menyimpan sesuatu ke koleksi yang belum ada. Sebuah koleksi punya:

- **Nama**, dan **satu baris tentang isinya**. Agent melihat keduanya, jadi tahu kapan perlu mencari di sana.
- **Siapa yang boleh dijawab darinya** (lihat di bawah).
- **Agent mana yang mencarinya**: semua agent, kecuali Anda memilih beberapa.
- **Tentang siapa**, kalau isinya tentang orang: dokumen seseorang tampil bersama apa yang diketahui tentang orang itu,
  di **Knowledge & Memory → People**, dan didahulukan saat percakapan membicarakan orang itu. Ini tidak mengatur siapa
  yang boleh membacanya.

## Siapa yang boleh dijawab dari sebuah koleksi

Koleksi tertutup sampai Anda membukanya. Siapa yang boleh dijawab darinya tergantung di mana koleksi itu dibuat:

| Dibuat | Yang boleh dijawab darinya |
|---|---|
| Di dashboard | Orang yang membuatnya |
| Dari chat | Orang-orang di chat itu, atau grup itu |
| Sebagai folder manual, tanpa pengaturan | Para admin |

Admin bisa membuka koleksi untuk semua orang, atau untuk satu grup, dari kartunya. Agent tidak pernah bisa.

Sebuah koleksi dipakai kalau setiap orang di percakapan boleh dijawab darinya. Jadi koleksi grup keluarga tidak dipakai
di chat pribadi.

**Koleksi milik satu orang ikut orangnya ke grup**, pada pesan yang ia kirim di sana dan tidak pada pesan orang lain:
Anda meminta dokumen Anda sendiri di grup keluarga dan agent menemukannya, sedangkan orang lain di grup yang memintanya
diberi tahu bahwa dokumen itu tidak ada. Siapa yang bertanya adalah pengirim yang dilaporkan aplikasi chat, bukan isi
pesannya. Yang ditemukan agent untuk Anda tidak disimpan di percakapan grup, jadi pertanyaan orang berikutnya tidak
memilikinya.

- Tiap koleksi seperti itu punya **In a group** di setelannya: ikut setelan memory, ya, atau tidak. Setelan memory-nya
  adalah **In a group, an agent uses what a person told it in private** di Knowledge & Memory → Settings, menyala
  kecuali Anda matikan.
- Agent yang berjalan di coding CLI tidak diberi koleksi milik seseorang di grup: sesinya menyimpan semua yang pernah
  dikatakan kepadanya.

## Menambah dokumen

- **Di dashboard:** seret file ke sebuah koleksi, atau **Tulis dokumen** di sana.
- **Dari chat:** kirim file atau link-nya, lalu minta disimpan: "simpan SOP ini ke Keuangan". Dokumen langsung tersimpan
  ke koleksi untuk orang-orang di chat itu. Kalau koleksinya terbuka untuk lebih banyak orang daripada chat itu, dokumen
  menunggu persetujuan admin di tab Knowledge, dan agent memberi tahu Anda.
- **Dari terminal:** `nouride knowledge add <file> --to <koleksi>`.
- **Manual:** koleksi adalah folder di `.nouride/knowledge/` (di Docker, di dalam volume). File yang ditaruh di sana,
  oleh Anda atau alat seperti Syncthing, terbaca dalam lima menit.

Nouride membaca Markdown, teks, CSV, halaman web, PDF, Word, Excel, PowerPoint dan versi OpenDocument-nya, sampai 50 MB
per file. File PDF dan Office dibaca dengan Python, yang tidak ada di image Docker; PDF juga butuh `pdftotext` (atau pypdf
di Python), dan file lama `.doc`, `.xls` dan `.ppt` butuh LibreOffice. Kalau belum ada, dokumennya memberi tahu dan
halaman menawarkan untuk memasangnya; setelah terpasang, dokumen terbaca dalam lima menit.

**File jenis apa pun bisa disimpan.** Gambar, video, atau PDF hasil scan yang tidak berisi teks disimpan apa adanya.
Nouride tidak membaca kata-katanya, jadi file itu ditemukan lewat judulnya dan lewat satu kalimat tentang isinya: agent
yang menyimpan foto kiriman Anda menulis kalimat itu dari yang dilihatnya ("kode QR yang dipindai petugas SPBU, mobil BG
1234 XY"). File yang ditaruh langsung di folder ditemukan lewat namanya, dan Anda bisa menulis kalimatnya di bawah
`[notes]` di `knowledge.toml` milik koleksinya.

Di dashboard, dokumen sebuah koleksi diurutkan dari yang terbaru, masing-masing dengan kapan ditambahkan.

### Judul dokumen

Setiap dokumen punya judul, tampil di atas nama file-nya: kata-kata yang dipakai pencarian untuk menemukannya, dalam
bahasa apa pun. Agent yang menyimpan dokumen memberinya judul berbahasa Inggris yang menyebut dokumen itu apa, dengan
istilah aslinya ("NIB, business registration certificate (Nomor Induk Berusaha)"), jadi pencarian berbahasa Inggris
menemukan dokumen berbahasa Indonesia walaupun pencarian makna belum diatur. Nama file-nya tetap seperti saat dikirim.

Anda bisa memberi judul sendiri lewat ikon pensil di baris dokumen, dalam bahasa apa pun; kalau ditulis dalam bahasa
Inggris, agent menemukannya dari bahasa apa pun. Tanpa judul, judul dokumen adalah heading pertamanya atau nama file-nya.

## Cara agent memakainya

- Agent diberi tahu nama koleksi yang boleh ia cari di chat itu, dan tentang siapa masing-masing, tidak pernah isinya,
  jadi satu koleksi hanya memakan satu baris di prompt, bukan dokumennya.
- `memory_search` menemukan bagian dokumen di samping percakapan dan fakta lama, dan `memory_read` membuka satu bagian
  atau seluruh dokumen. Jawaban dari dokumen menyebut dokumen dan bagiannya.
- Dokumen selalu bisa ditemukan lewat kata-katanya, dan lewat makna kalau pencarian makna sudah diatur: model yang sama
  dengan memory, diatur sekali di Knowledge & Memory.
- Dokumen tetap dalam bahasa aslinya, dan judul berbahasa Inggrisnya membuatnya ketemu lewat bahasa Inggris.
- **Agent mengirim balik file yang disimpan, apa adanya**, saat Anda memintanya: fotonya, PDF-nya, spreadsheet-nya,
  sebagai lampiran di chat. Hanya dari koleksi yang boleh dipakai untuk menjawab di chat itu.
- Link disimpan sebagai keterangannya dan alamatnya, dan agent menjawab dengan alamat itu.

## Memory atau knowledge base

| Apa | Masuk ke mana |
|---|---|
| Sesuatu yang diceritakan seseorang tentang dirinya: pekerjaan, rencana, alergi | Memory, dipelajari tiap malam |
| Dokumen, file atau link yang diserahkan untuk disimpan | Knowledge base |
| Cara agent bekerja, apa yang sedang ia kerjakan | Catatan agent itu sendiri |

Kalau tidak jelas apakah sesuatu memang mau disimpan sebagai dokumen, agent bertanya sekali.

## Arsip, backup, terminal

**Arsipkan** menyimpan koleksi tanpa mencarinya, sampai Anda mengaktifkannya lagi. Folder knowledge di-backup dengan
jadwal yang sama dengan memory.

```bash
nouride knowledge                                  # koleksi, dan siapa yang boleh dijawab dari masing-masing
nouride knowledge search <kata> [--in <koleksi>]
nouride knowledge add <file> --to <koleksi>
nouride knowledge add - --name <nama file> --to <koleksi> < <file>   # file lewat standard input
nouride knowledge reindex [koleksi]                # baca ulang yang berubah di folder
nouride knowledge archive|unarchive <koleksi>
nouride knowledge in-groups <koleksi> on|off|default   # koleksi milik seseorang, di grup, pada pesannya sendiri
nouride knowledge title <koleksi>/<file> <kata>   # judulnya; "" menghapusnya
nouride knowledge rm <koleksi>/<file>
```

Koleksi disebut dengan namanya, seperti yang tampil di dashboard (`--to "Lab results"`), atau dengan id yang dicetak di
sebelahnya oleh daftar.

Di server, `nouride` yang dijalankan sebagai root berjalan sebagai akun layanannya sendiri, yang tidak bisa membaca file
di home root. Serahkan filenya lewat standard input: `sudo nouride knowledge add - --name manual.pdf --to House < manual.pdf`.
