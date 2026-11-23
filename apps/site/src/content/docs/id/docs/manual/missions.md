---
title: Misi
description: "Kerjaan panjang yang diselesaikan agent sendiri: cara mulainya, cara ia tetap di jalur, kapan dianggap selesai, dan apa yang ia tanyakan ke kamu."
---

**Misi** adalah kerjaan yang dikerjakan agent sendirian: kamu kasih tujuan, kamu tinggal pergi, lalu kembali ke
kerjaan yang sudah beres, atau ke satu pertanyaan yang jelas. Ia jalan giliran demi giliran, tetap jalan setelah
restart, dan baru dianggap selesai setelah dicek.

## Memulai

Biasanya kamu gak perlu. Kalau yang kamu minta itu kerja panjang, lebih dari sekitar satu jam, yang jalan dengan sedikit
input dari kamu (development panjang, analisis mendalam, scan panjang, riset dari banyak sumber, migrasi, menunggu
CI, kerjaan yang harus jalan terus waktu kamu pergi), agent membuat **draft** misi dan bilang apa yang akan dikerjakan
dan bagaimana ia dinilai selesai. Yang cuma beberapa menit ia kerjakan langsung di chat; yang lebih lama tapi kurang
dari sejam diserahkan ke helper atau agent lain di background, dan chat tetap bebas untukmu. Sejam itu batas satu
balasan: kerja yang mungkin lewat dari itu adalah urusan misi, yang gilirannya tahan restart dan jalan sendiri.

Draft tidak menjalankan apa pun sampai kamu memulainya:

```text
📝 Draft msn_3f2a91 · nix: Revise the RFC

Revise the RFC to the owner's answers of today, section by section, and say what changed in each.

5 checks · signed off by: you · brief: on the mission's page

Start it: /mission accept msn_3f2a91 · drop it: /mission stop msn_3f2a91
[Start it] [Drop it]
```

- **Namanya** adalah beberapa kata setelah nama agent (0.8.39), dan goal-nya utuh di bawahnya. Sejak itu misi
  disebut dengan namanya: di notifikasinya, di daftar, di kartu yang menunggu kamu. Agent memberi nama setiap misi yang
  ia draft atau mulai. Misi yang kamu mulai sendiri memakai **Name** yang kamu isi di form dashboard, atau dinamai dari
  kalimat pertama goal-nya. Misi yang dibuat sebelum 0.8.39 dinamai dengan cara itu waktu 0.8.39 dipasang.
- **Brief-nya** adalah `BRIEF.md` di folder misi: apa kerjaannya, kenapa, apa yang perlu dibaca, apa arti selesai. Ia
  ada di halaman misi, dan setiap giliran misi dimulai dari situ.
- **Ubah dulu** kalau belum pas: bilang ke agent ("cek-nya cuma grep, tambahkan yang menjalankan test") dan ia mengirim
  draft-nya lagi dengan perubahan yang disebut; atau ubah di halaman misi di dashboard. Setelah jalan, goal dan cek-nya
  tetap.
- **Mulai** dengan tombolnya, `/mission accept <id>`, tombol Start it di dashboard, atau dengan bilang ke agent untuk
  jalan; ia meneruskan kata-katamu, dan kata-kata itu disimpan bersama mulainya. **Drop it** membuangnya, beserta
  foldernya, begitu juga **Delete** di halamannya: draft langsung hilang, karena belum ada yang dijalankan.
- **Siapa yang mengesahkan** tertulis di draft: kamu, setelah cek-nya lolos, kecuali agent memilih pemeriksa, seperti
  yang ia lakukan kalau kamu pergi ("kerjakan ya, aku mau tidur"). Itu bisa kamu ubah di draft.
- **Batasnya sendiri** (0.8.46), kalau ada: satu baris di draft, `Its own limits before it asks you whether to go
  on: 24h of work (usually 12h) · 400M tokens (usually 250M)`. Agent mengisinya kalau kamu minta ("kasih dua hari")
  atau kalau kerjaannya memang butuh lebih banyak atau lebih sedikit; dengan memulainya, kamu setuju dengan batas itu.
  Draft tanpa baris itu mengikuti [batas](#batas) setelanmu. Ubah dengan bilang ke agent, atau di form draft di
  halamannya.
- Draft yang tidak dimulai siapa pun tetap ada di Backlog papan, sampai ada yang memulai atau membuangnya, berapa pun
  lamanya: draft tidak pernah kedaluwarsa. Ia tidak dihitung sebagai yang butuh kamu, dan kamu tidak diingatkan soal itu.
- **Notice sebuah draft itu satu pesan.** Kalau agent mengubah draft-nya, pesan itu ditulis ulang di tempatnya,
  tombolnya tetap, di aplikasi chat yang bisa menulis ulang pesan (Telegram, Discord). Di tempat lain satu baris
  bilang apa yang berubah. Dulu seluruh draft dikirim lagi tiap kali berubah.

Bilang "kerjain sekarang, gw tidur dulu"? Setiap misi yang dimulai agent selalu jadi draft dulu (0.8.40): ia membuat
draft-nya dan bilang begitu, lalu kamu yang memulainya, atau kamu suruh jalan dan ia memulai draft-nya atas kata-katamu.
Catatan yang sudah ia tulis tentang tugas itu, dan rencananya, ikut pindah; chat-nya menyisakan satu baris,
`→ mission msn_3f2a91, running`, yang berubah jadi hasilnya waktu misi selesai. `/mission <tujuan>` meminta agent yang
kamu sapa membuat draft dari tujuan itu: ia membaca yang perlu, menulis brief dan cek-nya, atau bertanya dulu kalau
tujuannya belum jelas. `/goal` adalah perintah yang sama. Misi yang kamu tulis di form dashboard, dan langkah misi di
otomasi, tetap langsung jalan: yang pertama kamu sendiri yang menulis, dan yang kedua tidak ada orang yang bisa menekan
Start.

`/mission` tanpa kata lain menampilkan yang belum selesai, seperti di halaman Missions: **Needs you**, **Working**, dan
**Backlog** (draft yang belum dimulai), masing-masing dengan jumlahnya. Misi yang sudah selesai, gagal, atau dihentikan
tidak ditampilkan; `/mission show <id>` tetap bisa menampilkan satu misi. Di grup, yang tampil misi grup itu. Di chat
langsung, yang tampil misi agent itu di mana pun dimulainya: milik chat itu dan yang kamu mulai sendiri, dan semuanya
kalau kamu admin. Misi yang dimulai di tempat lain diberi keterangan, dan ditindak dari sana atau dari halaman Missions.

Agent-mu juga paham istilahnya. Tanya apa isi backlog-nya atau bagaimana kabar suatu task, ia melihat daftar misinya
dulu sebelum menjawab; minta sesuatu dimasukkan ke backlog, ia membuat draft misi.

Untuk memulai sendiri:

```
/mission cek 52 dokumen yang di-link di KK 1.1, tandai masing-masing, lalu salin workbook-nya balik
```

atau **Missions → New mission** di dashboard: **Save to backlog** menyimpannya sebagai draft sampai kamu memulainya,
dan **Start now** langsung menjalankannya. Agent yang kamu sapa yang menjalankannya, atas nama kamu, dan ia melapor ke
chat tempat kamu memulainya.

`/goal`, nama yang dipakai tool lain, juga memulai misi. Misi adalah tujuan yang disahkan pihak lain: ia selesai kalau
cek-nya lulus dan pemeriksa setuju, bukan waktu agent bilang sudah selesai.

Kerjaan yang gak diminta siapa pun (ide agent setelah sebuah job selesai) juga gak pernah mulai sendiri. Ia jadi
draft, dan menunggu "ya" dari kamu.

## Yang kamu dengar

Chat tetap sepi. Misi cuma bilang:

- bahwa ia **mulai**, dengan goal-nya utuh dan cara menghentikannya;
- bahwa ia **butuh kamu** (approval, pertanyaan, batas yang tercapai, hasil yang perlu diterima), dengan tombol untuk
  yang bisa kamu jawab: Accept, Continue, Stop, atau satu tombol per pilihan di pertanyaannya. Pertanyaan dikirim saat
  itu juga ketika ditanyakan (0.8.39), bukan di akhir giliran tempat ia ditanyakan;
- bahwa ia **bertanya, dan lanjut bekerja sambil menunggu** (0.8.39): pertanyaan yang jawabannya gak ditunggu oleh sisa
  pekerjaannya. Misinya jalan terus, dan jawaban kamu diteruskan ke pekerjaan yang sedang berjalan. Kalau gilirannya
  selesai dan pertanyaannya masih terbuka, kamu diberi tahu sekali bahwa ia sudah mengerjakan yang bisa dikerjakan dan
  sekarang menunggu jawabannya. Misi yang sudah menyelesaikan semua yang lain padahal pertanyaannya masih terbuka gak
  lanjut ke pengecekan, dan kamu belum diminta menerima apa pun (0.8.41): ia memberi tahu sekali bahwa sisanya sudah
  selesai lalu menunggu jawaban kamu, karena jawabannya bisa mengubah pekerjaannya. Begitu dijawab, ia mengerjakan yang
  berubah karena jawaban itu dan bilang selesai lagi. Menerimanya apa adanya tetap menutup misinya. Hanya satu
  pertanyaan yang terbuka dalam satu waktu;
- bahwa ia **tertahan** karena modelnya gak bisa menjawab, dan mencoba lagi sendiri;
- bahwa ia **di-pause** (0.8.41), oleh siapa, dengan tombol Resume dan Stop;
- bahwa ia **selesai**, dengan hasilnya dalam dua-tiga kalimat; lalu **laporan** utuhnya sebagai `report.md`, dan file
  yang ia buat untukmu: dokumen, gambar, spreadsheet. Kode yang ia ubah di repo tetap di branch-nya, yang disebut di
  notifikasinya, dan tidak dikirim;
- atau bahwa ia **berakhir**, dengan alasannya, dan laporannya sebagai `report.md` kalau ia menulisnya.

Hasil dan laporannya memakai bahasamu, ditulis formal seperti dokumen. Hasil yang menunggu persetujuanmu datang
bersama `report.md`-nya, supaya kamu membacanya dulu sebelum memutuskan, dan tidak dikirim lagi saat kamu menerimanya.
Tidak ada yang kamu tulis dipotong di jalan: goal-nya, yang kamu sampaikan saat ia bekerja, dan yang ia laporkan.

Laporan bukan cuma teks (0.8.40). Kalau pekerjaannya punya bentuk, agent menggambarnya, menyerahkan gambarnya di
antara file hasil, sehingga chat menerimanya sebagai gambar, dan menyebutnya di laporan; halaman mission menggambarnya
di sana, di tempatnya. Daftar hal beserta statusnya ditulis sebagai tabel.

Notifikasi *mulai*, *butuh kamu*, dan *selesai* diakhiri link ke halaman misinya, di chat yang mendapat link:
[Link dari chat](/id/docs/manual/dashboard/#link-dari-chat).

Di antara itu, satu baris progres yang ditulis dari checklist-nya ("3 dari 8 langkah selesai"), paling sering tiap
setengah jam, dan cuma kalau ada langkah yang selesai. Kalau ia menunggu kamu, ia mengingatkan sekali lagi setelah empat
jam; tidak pernah untuk draft, dan tidak pernah untuk misi yang kamu pause.

## Memantaunya

**Missions** di dashboard adalah sebuah papan (0.8.40). Tiga kolom berisi yang masih terbuka: **Backlog**,
draft-draft; **Working**, yang mengantre, jalan atau sedang dicek; **Needs you**, pertanyaan, approval, batas atau
hasil yang perlu diterima. Di bawahnya **Finished** mendaftar yang selesai, gagal atau dihentikan, satu baris
masing-masing. Tiap kartu punya namanya, bar progres checklist-nya, satu baris yang penting (kapan draft dianggap
selesai, langkah yang sedang dikerjakan, yang ditanyakan), kucing agent-nya dan waktunya; baris Finished menyebut
kenapa gagal atau siapa yang menghentikan. Arahkan kursor ke waktunya, atau capai dengan keyboard, untuk melihat
tanggal dan jam ia dibuat, dimulai dan selesai. **Start** di draft dan **Answer** di pertanyaan bisa langsung dari
kartunya.

Tiap kolom menampilkan lima yang terbaru, dengan **Show more** di bawahnya. Finished menampilkan 7, 14, 21 atau 30 hari
terakhir (7 kalau tidak dipilih), dengan Done, Failed dan Stopped untuk menyaringnya; yang masih terbuka ditampilkan
berapa pun umurnya. Kalau tidak ada yang terbuka, ketiga kolom jadi satu baris tipis dan Finished mengisi halamannya.
Pencarian dan filter per agent berlaku untuk semua kolom. Di HP papannya jadi empat tab dengan jumlahnya, Finished yang
keempat, terbuka di Needs you kalau ada isinya, dan tanggalnya tertulis di samping tiap waktu.

Hal yang sama bisa ditanyakan ke agent di chat-nya: "apa saja yang ada di backlog kamu?" Ia menjawab untuk mission
miliknya sendiri, yang ia kerjakan dan yang ia buatkan draft-nya untuk agent lain: semua yang masih terbuka berapa pun
umurnya, draft disebut sebagai draft yang belum dimulai, dan dua puluh yang terakhir selesai.

Halaman sebuah mission dimulai dengan apa yang sedang dikerjakannya dan sudah sejauh mana, lalu brief-nya dan hasilnya
begitu ada, masing-masing selebar halaman, dan checklist-nya di atas turn-turn-nya, dengan foldernya, apa yang
menentukan ia selesai dan kotak untuk memberi tahu sesuatu di sampingnya. Checklist yang panjang menampilkan lima
langkah di sekitar yang sedang dikerjakan, dan turn-nya lima yang terbaru, sisanya tinggal ditekan. Halaman draft hanya
berisi yang bisa kamu ubah sebelum ia dimulai.

**Yang menunggu kamu bilang apa yang ditunggu** (0.8.39), di Home, di Work dan di daftar: pertanyaan dengan
pertanyaannya, hasil yang perlu diterima, batas yang tercapai. Misi yang bertanya sambil
lanjut bekerja ikut tampil di situ, ditandai **Working · asked a question**, dan halamannya memuat pertanyaannya dan
kotak untuk menjawab.

**Misi yang sedang bekerja kelihatan hidup** (0.8.39). Misi yang dikerjakan coding CLI (Claude Code, Codex) sering
berupa satu giliran yang berjam-jam. Kartunya bilang kapan langkah terakhirnya ("last step 7 min ago"), dan yang sudah
dipakai giliran yang sedang jalan ikut dihitung, sebagai perkiraan, di halamannya dan di `nouride mission show`.
Notifikasi 80% dari sebuah batas juga datang di tengah giliran seperti itu.

Halaman satu misi menunjukkan langkah, giliran, jam dan token terhadap
batasnya, langkah yang sedang ia kerjakan saat itu juga, checklist dengan catatan tiap langkah, panggilan yang
diparkir untuk kamu (bisa dijawab langsung di sana), pertanyaannya, laporan dan file-nya di bagian atas begitu ada,
dan setiap gilirannya sebagai timeline, yang terbaru di atas, masing-masing ditandai apa yang memulainya (langkah
berikutnya, jawaban agent lain, job selesai, approval, coba lagi) dan bagaimana hasilnya, dengan jeda sebelumnya, dan
kegagalan yang sama berturut-turut ditampilkan sekali. Stop, Continue, Accept dan Answer muncul kalau berlaku, dan
**Accept as it is** di misi yang menunggu hal lain. Selama misinya masih terbuka, **Tell it** menerima pesan untuknya, dan
menampilkan apa saja yang sudah disampaikan berikut sudah dibaca atau belum.

**Misi menunggu job yang selesai, tidak pernah menunggu server** (0.8.38). Build atau tes yang ia tinggalkan di latar
membangunkannya saat selesai. Server yang ia nyalakan untuk melihat hasil kerjanya (preview, server statis) jalan di
sampingnya dan tidak menahan apa-apa: misinya lanjut ke langkah berikutnya, dan server itu dimatikan saat misinya
selesai. Kalau sebuah misi sudah menunggu satu jam untuk sebuah job, ia diberi tahu job yang mana, satu kali, untuk
jaga-jaga kalau job itu memang tidak akan pernah selesai.

**Satu misi dimiliki satu orang** (0.8.35): yang memulainya, dari chat atau dari halaman ini, dan misi yang dimulai
sebuah automation jadi milik pemilik automation itu. Halaman ini menampilkan milikmu, dan hanya pemiliknya atau admin
yang bisa menyampaikan sesuatu, menghentikan, melanjutkan, menerima, menjawab, atau menghapusnya. Misi yang diusulkan
agent sendiri dijawab oleh siapa pun yang boleh membuka chat tempat ia diusulkan, lalu jadi milik orang itu. Kamu juga
melihat misi milik orang lain yang melapor ke chat-mu: ia menyebut milik siapa, dan bisa kamu baca tanpa mengubahnya.
Selain itu, operator atau viewer tidak melihat milik orang lain, tidak di daftar dan tidak lewat link-nya. Admin memilih
milik siapa lewat dropdown di samping pencarian, seperti di
[Automations](/id/docs/manual/schedule/#automation-ini-milik-siapa): Mine, Everyone yang dipisah per orang, satu orang,
atau Nobody's.

**Misi yang dihentikan tetap menyimpan pemakaian giliran terakhirnya** (0.8.39): misi yang dihentikan di tengah
giliran tetap dihitung gilirannya, tokennya dan token helper-nya. Notifikasinya menyebut pekerjaan di foldernya yang
belum di-commit siapa pun, beserta branch-nya.

Sejak 0.8.13, misi yang sudah berakhir bisa dihapus (**Delete** di halamannya, atau `nouride mission delete <id>`)
beserta percakapannya, checklist-nya dan folder yang dibuat Nouride untuknya; folder yang kamu tentukan sendiri dan
branch-nya tetap ada. Misi yang masih terbuka harus di-stop dulu; tombol Delete baru muncul setelahnya. Kerja di
foldernya yang belum di-commit menahan penghapusan dan disebutkan; kalau tetap dihapus, kerja itu hilang.

## Menyampaikan sesuatu saat ia bekerja

Sejak 0.8.10, `/mission tell <id> <pesan>` (atau **Tell it** di halamannya, atau `nouride mission tell`) kasih misi
yang lagi jalan sesuatu untuk diketahui: "pakai tab kedua", "klien maunya PDF", "berhenti setelah langkah tiga terus
lapor". Agent-nya mengikutinya: kata-kata kamu yang terbaru menang atas detail tujuannya. Tujuannya sendiri, cek, dan
batasnya tetap seperti semula: cek tetap yang menentukan kapan misi selesai, dan kalau pesan kamu bikin ceknya gagal,
atau minta pekerjaan yang sama sekali lain, agent-nya nanya ke kamu. Mau ganti tujuan? Stop, lalu mulai misi baru.

- **Lagi bekerja:** dibaca sebelum langkah berikutnya. Misi yang dikerjakan agent ber-Claude Code atau Codex
  menerimanya di tengah prompt yang sedang jalan; kalau ada perintahnya yang lagi jalan, pesan kamu nunggu perintah itu
  selesai, paling lama lima menit.
- **Lagi menunggu atau antre:** disimpan untuk giliran berikutnya, dan balasannya bilang apa yang bikin misinya jalan
  lagi: jawaban kamu, continue, atau accept. Tell gak pernah menjawab pertanyaan dan gak pernah bikin misi yang menunggu
  jalan sendiri.
- **Lagi dicek:** kalau cek gagal, giliran berikutnya membacanya. Kalau lolos, misi yang kamu accept menunggu kamu
  dengan pesan kamu ditampilkan di samping hasilnya; misi yang bakal selesai sendiri jalan satu giliran lagi untuk
  membacanya, lalu dicek ulang.

Setiap tell disimpan di misinya, lengkap dengan giliran yang membacanya, dan muncul di setiap halaman sesudahnya, jadi
giliran-giliran berikutnya, dan reviewer-nya, tahu apa yang kamu bilang. Agent bisa meneruskan kata-kata kamu dari chat
kamu ("bilangin ke misi laporan pakai PDF") kalau kamu yang memulai misinya atau kamu admin; agent gak bisa
menyampaikan apa pun atas kemauannya sendiri.

## Cara ia tetap di jalur

Setiap giliran misi mulai dari **halamannya** (tujuan, cara ia dicek, checklist dan catatannya, folder-nya, cek
terakhir yang gagal, pertanyaan yang ia ajukan dan jawaban kamu), gak pernah dari giliran-giliran sebelumnya. Misi lima
puluh giliran membawa lima puluh halaman, bukan satu percakapan yang terus memanjang sampai agent kehilangan arah.

## Selesai berarti sudah dicek

Waktu agent bilang selesai:

1. **Cek-nya dijalankan.** Perintah yang ia sebut di awal (`bun test`, skrip yang membaca balik workbook lewat ssh,
   `test -s summary.txt`) dijalankan di folder-nya, seperti perintah agent sendiri. Yang gagal jadi giliran berikutnya,
   dengan output-nya. Cek jalan tanpa ada yang bisa ditanya dan tanpa kredensial yang terikat ke programnya, jadi ia
   membaca apa yang ada di disk: file, branch lokal, test di worktree. Cek yang butuh approval kamu ditolak waktu misi
   dimulai, supaya agent langsung menulis cek lain.
2. **Pemeriksa melihat.** Pembaca kedua dengan konteks bersih yang gak ikut mengerjakan, di model `high` milik agent,
   yang cuma memegang tool untuk membaca, mengecek hasilnya terhadap tujuan. Laporan agent adalah klaim yang ia cek,
   bukan bukti. Kalau ia bilang gagal, itu juga jadi giliran berikutnya. Tiap pemeriksaan punya waktu sepuluh menit:
   yang kehabisan waktu belum menilai apa-apa, jadi gak pernah dihitung gagal; pemeriksaan berikutnya melanjutkan dari
   catatannya, tiga kali paling banyak, lalu kamu yang memutuskan, dengan apa yang sudah ia cek. Misi yang dimulai
   dengan `review = false` melewatinya.
3. **Kamu menerima,** kalau gak ada perintah yang bisa menilai (ringkasan, draf), atau kalau misinya minta begitu:
   `/mission accept <id>`, atau `/mission continue <id> <apa yang kurang>`.

Kegagalan yang sama tiga kali berturut-turut menghentikan misi dan bertanya ke kamu, daripada menghabiskan giliran di
lingkaran yang sama, begitu juga kalau pemeriksa menolaknya tiga kali berturut-turut, apa pun temuannya tiap kali.

**Misi yang menunggu kamu bisa kamu terima apa adanya** (pertanyaan, cek yang gak bisa ia lewati, batas):
`/mission accept <id>` menutupnya sebagai selesai, dan notifikasinya bilang cek-nya gak lulus. Pekerjaan yang selesai
lewat jalan lain ditutup dengan catatan: `/mission accept <id> --outside "<di mana>"`.

## Kalau modelnya gak bisa menjawab

Batas pemakaian, rate limit, provider yang sedang down: misinya **tertahan** dan mencoba lagi sendiri,
setelah 2, 10 dan 30 menit, lalu tiap jam, selama kira-kira sehari. Kamu diberi tahu sekali waktu ia tertahan dan sekali
waktu ia jalan lagi; waktu menunggunya gak dihitung ke batas jamnya. **Retry now** mencoba saat itu juga, **Stop**
mengakhirinya. Setelah sehari, misinya bertanya ke kamu.

Selama tertahan gak ada yang diminta dari kamu, jadi ia gak ada di Needs you: di board ia tetap di **Working** dengan
tanda **Held up**, dan kartu serta halamannya bilang kapan percobaan berikutnya ("It tries again by itself in 43 min").
Misi yang sempat bekerja lagi setelah satu percobaan lalu tertahan lagi, seperti misi di paket yang punya batas tiap
beberapa jam, memberi tahu kamu lagi dan mulai lagi dari 2 menit.

## Mem-pause misi

Misi yang sedang jalan atau masih antre bisa di-pause (0.8.41): **Pause** di halamannya, `/mission pause <id>` di
chatnya, atau `nouride mission pause <id>`. Gilirannya yang sedang jalan dipotong dan job-job latar belakangnya
dihentikan, sama seperti waktu kena batas. Gak ada yang hilang: checklist, folder dan kerjanya sejauh ini disimpan, dan
agent-nya bebas mengerjakan yang lain. Misi yang di-pause di sebuah repo tetap memegang repo itu, jadi misi lain di
repo yang sama menunggu sampai ia lanjut atau dihentikan.

Ia tetap di-pause selama yang kamu mau. Waktu selama di-pause gak dihitung ke batas mana pun, dan kamu gak diingatkan
soal itu. **Resume** di halamannya atau di kartunya di Needs you, tombol **Resume** di bawah notifikasinya, atau
`/mission continue <id>`, membuatnya lanjut dari checklist-nya; misi yang di-pause waktu masih antre kembali masuk
antrean. **Stop** mengakhirinya.

Siapa pun yang boleh menghentikan misi boleh mem-pause-nya. Orchestrator bisa mem-pause misi agent mana pun kalau kamu
memintanya, dan cuma bisa melanjutkan misi yang ia pause sendiri: misi yang kamu pause, kamu yang melanjutkan. Misi
yang sedang dicek, yang sudah menunggu kamu, dan draft gak bisa di-pause, karena gak ada yang sedang jalan di situ.

## Pertanyaannya

Misi bertanya lewat pertanyaannya sendiri, bukan lewat pesan yang ia kirim. Pertanyaan sampai ke chat tempat misi itu
melapor, dengan satu tombol per pilihan, dan dijawab di sana dengan kata-katamu sendiri, dengan tombol, dengan
`/mission answer <id> <jawaban>`, di halaman misinya, atau dengan bilang ke agent-nya.

Pesan yang dikirim misi sendiri tetap pesan biasa, dan jawaban atas pesan itu gak kembali ke misinya. Karena itu chat
tempat misi melapor ada di urutan pertama daftar chat yang bisa dikirimi agent, dan ditandai sebagai milik misi itu
(0.8.39), dan percakapan yang dipakai misi untuk kerjanya sendiri bukan chat yang bisa dikirimi apa pun.

## Approval

Misi gak berhenti di satu pertanyaan. Panggilan yang butuh approval kamu **diparkir**: promptnya datang ke chat kamu,
misi jalan terus dengan apa pun yang gak bergantung padanya, dan jawaban kamu (kapan pun dalam sehari) jadi giliran
berikutnya. Ia menunggu kamu begitu satu giliran gak menyelesaikan satu langkah pun (mengecek approval bukan kemajuan), dan misi
yang berakhir menarik apa yang ia parkir. Ia jalan di level approval kamu, atas nama kamu.

## Batas

| | Default | Yang dibatasi |
|---|---|---|
| `per_agent` | 1 | misi yang bekerja bersamaan untuk satu agent; yang sedang dicek tidak dihitung, karena pemeriksanya bukan agent itu. Tiap agent bisa punya angkanya sendiri, 1 sampai 4 |
| `max_running` | sesuai kemampuan mesin, 1 sampai 4 | misi yang jalan bersamaan di box |
| `limit_hours` | 12 | jam kerja; waktu menunggu kamu gak dihitung |
| `limit_turns` | 250 | giliran (tiap giliran sampai `max_tool_iterations` langkah), termasuk milik pemeriksa dan cek yang gagal |
| `limit_tokens` | 250.000.000 | token input dan output, termasuk milik pemeriksa |

Semuanya ada di `[missions]` di `config.toml`, dan di **Limits** pada halaman Missions di dashboard, tanpa restart. Misi mengambil batasnya saat dibuat: perubahan
berlaku untuk misi yang dimulai atau dibuat draft-nya setelah itu. Misi yang menunggu kamu gak memakai slot; yang
berikutnya menunggu di antrean dan bilang sedang menunggu apa. Sebelum 0.8.46 tiga batas itu 8 jam, 100 giliran dan
100.000.000 token; nilai yang kamu isi sendiri tetap dipakai.

**Batas milik satu misi** (0.8.46) gak mengubah setelan di atas. Agent mengisinya di draft (`limit_hours`,
`limit_turns`, `limit_tokens`), masing-masing dalam rentang yang boleh untuk setelannya (seperempat jam sampai 168
jam, 1 sampai 1.000 giliran, 100.000 token atau lebih), dan draft menunjukkannya ke kamu sebelum kamu mulai. Kamu
mengubahnya di form draft: **Hours**, **Turns** dan **Tokens**, dalam juta. Bagian kerja yang diserahkan sebuah misi
ke agent lain, dan langkah misi di sebuah automation, mulai tanpa ada yang bilang ya, jadi tetap memakai setelan.

**Jumlah misi bersamaan untuk satu agent** diatur di halaman Settings agent itu, **Missions at once**, atau
`[missions] per_agent` di `config.toml` miliknya sendiri: tiga untuk agent yang mengerjakan pekerjaan panjang, satu
untuk yang lain. `max_running` milik box tetap membatasi semuanya, jadi naikkan juga. Dua misi di satu repo tetap
bergantian, berapa pun angkanya: mereka bisa saling menimpa file.

Kalau `max_running` gak diisi, nilainya ikut mesin: satu untuk tiap core selain satu, dan satu untuk tiap GiB memori
yang boleh dipakai perintah agent, diambil yang lebih kecil, minimal 1 dan maksimal 4, dan gak pernah lebih dari yang
bisa dijalankan agent-agentnya sekaligus. Box 4 core 2 GB menjalankan 1, 4 core 4 GB menjalankan 2, 6 core 8 GB
menjalankan 4. Isi sendiri kalau mau lebih, sampai sebanyak semua agent. Di form Limits, kotak yang kosong berarti default-nya, yang tampil abu-abu; **Back to
defaults** mengosongkan semuanya.

Kalau satu batas tercapai, job-job misi dihentikan dan ia bertanya: `/mission continue <id>` menaikkan batas yang
tercapai sebesar setelannya, dihitung dari posisinya sekarang (`limit_tokens` token lagi setelah batas token), dan
batas lain tetap; `/mission stop <id>` mengakhirinya. Gak dijawab seminggu, ia berakhir.

## Setelah restart

Misi yang sedang jalan lanjut dari halamannya. Kalau restart memotong sebuah panggilan di tengah jalan, misi diberi tahu
yang mana: yang cuma membaca dijalankan lagi kalau perlu; yang mungkin sudah mengubah sesuatu dicek dulu sebelum
diulang; yang ditanyakan approval (hapus, kirim) gak diulang, dan misi menunggu kamu. Misi yang terus mati di setiap
restart tanpa satu langkah pun selesai akan berhenti.

## Folder, file, dan memorinya

Setiap misi dapat folder di bawah folder privat agent-nya, dihapus seminggu setelah misi berakhir. Kalau dimulai dengan
`workdir` (folder atau repositori yang sudah ada), ia bekerja di sana, atau di repositori git di worktree-nya sendiri
(lihat di bawah), dan folder yang diberikan itu gak pernah dihapus. Folder misi yang masih menyimpan kerjaan yang
belum di-commit ditahan, dan disebut di log. Folder yang misinya sudah gak tercatat sama sekali dihapus setelah
seminggu gak disentuh (0.8.36), dengan aturan yang sama soal kerjaan yang belum di-commit. Waktu berakhir, ia dicatat
sekali di memori agent-nya, dari laporannya.

Misi punya percakapan sendiri, bukan percakapanmu: `/new`, `/reset` atau menghapus chat tempat ia dimulai gak
menghentikannya, dan ia tetap melapor ke sana. Percakapan itu ada di halaman misinya, bukan di daftar Chat. Setelah
berakhir, misi disimpan selama percakapan disimpan, `[retention] session_days` (30 hari), lalu dihapus; misi yang
masih berjalan gak pernah dihapus, selama apa pun ia berjalan.

Semua yang dikabarkan misi ke chat-nya dikirim atas nama agent-nya: ia antre atau mulai, sudah sampai mana, hampir
kena batas, butuh apa dari kamu, lanjut lagi, selesai, dengan hasilnya. Agent di chat itu membaca kabar yang sama
bersama pesanmu berikutnya di sana (0.8.42), sekali, persis seperti yang kamu baca: apa pun yang dikabarkan sejak ia
terakhir menjawabmu di sana. Sebelumnya ia hanya tahu pernah memulai misi, dan bisa menjawab bahwa misi yang sudah
selesai masih berjalan. Dari baris progres sebuah misi ia membaca yang terbaru. Setelah `/new` ia mulai dari nol,
seperti hal lainnya, dan bisa melihat daftar misinya sendiri.

Saat misi berakhir, yang sedang dijalankannya ikut berakhir: job latar belakangnya, dan (0.8.42) apa pun yang
dimulai salah satu perintahnya tanpa ditunggu, misalnya worker build yang tertinggal. Masing-masing diminta berhenti
dan, sesaat kemudian, dihentikan, lalu chat-nya diberi tahu apa yang dihentikan. Program yang sengaja memisahkan diri
tetap jalan: process manager, container, service sistem. Begitulah cara membuat sesuatu tetap hidup setelah misi
selesai.

Agent di coding CLI menjalankan perintahnya dari shell CLI itu sendiri, jadi Nouride gak memegang satu pun
perintahnya. Sejak 0.8.43 yang dimulai misi seperti itu tetap diikuti: proses yang melayani sesi misi itu ditaruh
di kelompoknya sendiri, dan saat misi berakhir dan sesinya ditutup, apa pun yang dimulai sebuah perintahnya tanpa
ditunggu ikut dihentikan bersama yang lain, dalam pemberitahuan yang sama. Yang sengaja memisahkan diri, misalnya
daemon milik build yang tetap hidup untuk build berikutnya, dibiarkan jalan, dan pemberitahuannya menyebut namanya,
karena gak ada tempat lain yang bilang ia masih ada. Ini butuh instalasi yang service-nya menyerahkan control
group-nya, seperti instalasi systemd; di container, dan di tempat lain, perintah coding CLI gak diikuti, dan yang
ditinggalkannya dibiarkan. CLI yang melayani semua sesinya dari satu proses juga gak diikuti: di sana gak ada yang
milik satu misi saja.

Di dalam misi, agent bisa menyerahkan satu bagian terpisah ke agent lain sebagai misi tersendiri (satu tingkat, gak
lebih dalam), dan diberi tahu bagaimana hasilnya.

## Di dalam repo

Misi yang `workdir`-nya ada di repositori git, di box yang cukup lega, kerja di worktree-nya sendiri:
`workspace/private/<agent>/missions/<id>/worktree`, di branch `mission/<id>`, dibuat dari commit terakhir repositori
itu. Cukup lega artinya perintah agent kebagian 512 MiB, sama seperti kebutuhan agent eksternal, dan disk yang kosong
dua kali ukuran file repositori yang ter-checkout. Yang belum di-commit gak diambil dan gak disentuh, jadi commit dulu
apa yang mau dijadikan titik mulai misi. Dengan begitu dua misi di repositori yang sama bisa kerja berdampingan.

Notifikasi yang minta persetujuan kamu, notifikasi selesai, dan halaman misi menyebut branch-nya. Merge atau push
branch itu keputusan agent, lewat approval gate seperti push lainnya. Seminggu setelah misi berakhir, folder-nya dihapus
beserta worktree di dalamnya, kecuali ada worktree di sana yang menyimpan kerjaan yang belum di-commit: folder itu
disimpan, dan log-nya bilang begitu. Branch-nya tetap ada di repositori, apa pun yang terjadi.

Kalau box gak cukup lega, misi kerja di folder yang diberikan, dan satu repositori dikerjakan satu misi dalam satu
waktu: yang berikutnya menunggu di antrean dan bilang misi mana yang ditunggunya. Misi yang sedang menunggu kamu tetap
memegang repositori-nya.

Di misi yang kerja di worktree, `delegate` dengan `isolated` memberi tiap helper worktree dari worktree misi itu, di
branch sendiri, `mission/<id>-helper-<n>`; hasilnya menyebut branch-branch itu, untuk di-merge oleh misinya. Di luar
itu, `isolated` ditolak.

## Perintah

| Di chat | |
|---|---|
| `/mission <tujuan>` | agent yang kamu sapa membuat draft dari tujuanmu; jalan setelah kamu memulainya |
| `/mission` | yang jalan dan menunggu di sini, yang butuh kamu paling atas |
| `/mission stop <id>` | akhiri |
| `/mission pause <id>` | tahan di tempatnya: gilirannya dipotong, job-nya dihentikan, kerjanya disimpan |
| `/mission continue <id> [catatan]` | lanjut melewati batas, keluar dari macet, setelah di-pause, atau dengan apa yang kurang setelah dicek |
| `/mission accept <id>` | terima hasilnya, atau usulan, yang lalu mulai; di misi yang menunggu hal lain, terima apa adanya |
| `/mission accept <id> --outside "<di mana>"` | tutup sebagai selesai lewat jalan lain, cek-nya gak dijalankan |
| `/mission answer <id> <jawaban>` | jawab pertanyaannya |
| `/mission tell <id> <pesan>` | sampaikan sesuatu saat ia bekerja; dibaca sebelum langkah berikutnya lalu diikuti, bukan tujuan baru |

Id-nya yang pendek seperti di notifikasi, `msn_3f2a91`. Di grup, orang yang memulai misi atau admin yang bisa
mengaturnya. Dari shell: `nouride mission [list|show|stop|continue|accept|answer|tell]`.
