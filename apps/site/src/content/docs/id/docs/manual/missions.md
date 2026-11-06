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
📝 Draft msn_3f2a91 · nix: Revise the RFC to the owner's answers

5 checks · signed off by: you · brief: on the mission's page

Start it: /mission accept msn_3f2a91 · drop it: /mission stop msn_3f2a91
[Start it] [Drop it]
```

- **Brief-nya** adalah `BRIEF.md` di folder misi: apa kerjaannya, kenapa, apa yang perlu dibaca, apa arti selesai. Ia
  ada di halaman misi, dan setiap giliran misi dimulai dari situ.
- **Ubah dulu** kalau belum pas: bilang ke agent ("cek-nya cuma grep, tambahkan yang menjalankan test") dan ia mengirim
  draft-nya lagi dengan perubahan yang disebut; atau ubah di halaman misi di dashboard. Setelah jalan, goal dan cek-nya
  tetap.
- **Mulai** dengan tombolnya, `/mission accept <id>`, tombol Start it di dashboard, atau dengan bilang ke agent untuk
  jalan; ia meneruskan kata-katamu, dan kata-kata itu disimpan bersama mulainya. **Drop it** membuangnya, beserta
  foldernya.
- **Siapa yang mengesahkan** tertulis di draft: kamu, setelah cek-nya lolos, kecuali agent memilih pemeriksa. Kalau
  dimulai langsung karena kamu pergi ("kerjakan sekarang, aku mau tidur"), cek lalu pemeriksa. Itu bisa kamu ubah di
  draft.
- Draft yang tidak dimulai siapa pun tetap ada, tercantum di bagian butuh kamu, sampai ada yang memulai atau
  membuangnya.

Bilang "kerjain sekarang, gw tidur dulu"? Agent memulainya langsung, tanpa draft, dan notifikasi *mulai*-nya mengutip
kata-katamu. Catatan yang sudah ia tulis tentang tugas itu, dan rencananya, ikut pindah; chat-nya menyisakan satu baris,
`→ mission msn_3f2a91, running`, yang berubah jadi hasilnya waktu misi selesai.

Untuk memulai sendiri:

```
/mission cek 52 dokumen yang di-link di KK 1.1, tandai masing-masing, lalu salin workbook-nya balik
```

atau **Missions → New mission** di dashboard. Agent yang kamu sapa yang menjalankannya, atas nama kamu, dan ia melapor
ke chat tempat kamu memulainya.

`/goal`, nama yang dipakai tool lain, juga memulai misi. Misi adalah tujuan yang disahkan pihak lain: ia selesai kalau
cek-nya lulus dan pemeriksa setuju, bukan waktu agent bilang sudah selesai.

Kerjaan yang gak diminta siapa pun (ide agent setelah sebuah job selesai) juga gak pernah mulai sendiri. Ia jadi
draft, dan menunggu "ya" dari kamu.

## Yang kamu dengar

Chat tetap sepi. Misi cuma bilang:

- bahwa ia **mulai**, dengan goal-nya utuh dan cara menghentikannya;
- bahwa ia **butuh kamu** (approval, pertanyaan, batas yang tercapai, hasil yang perlu diterima), dengan tombol untuk
  yang bisa kamu jawab: Accept, Continue, Stop, atau satu tombol per pilihan di pertanyaannya;
- bahwa ia **berhenti sebentar** karena modelnya gak bisa menjawab, dan mencoba lagi sendiri;
- bahwa ia **selesai**, dengan hasilnya dalam dua-tiga kalimat; lalu **laporan** utuhnya sebagai `report.md`, dan file
  yang ia buat untukmu: dokumen, gambar, spreadsheet. Kode yang ia ubah di repo tetap di branch-nya, yang disebut di
  notifikasinya, dan tidak dikirim;
- atau bahwa ia **berakhir**, dengan alasannya, dan laporannya sebagai `report.md` kalau ia menulisnya.

Hasil dan laporannya memakai bahasamu, ditulis formal seperti dokumen. Hasil yang menunggu persetujuanmu datang
bersama `report.md`-nya, supaya kamu membacanya dulu sebelum memutuskan, dan tidak dikirim lagi saat kamu menerimanya.
Tidak ada yang kamu tulis dipotong di jalan: goal-nya, yang kamu sampaikan saat ia bekerja, dan yang ia laporkan.

Notifikasi *mulai*, *butuh kamu*, dan *selesai* diakhiri link ke halaman misinya, di chat yang mendapat link:
[Link dari chat](/id/docs/manual/dashboard/#link-dari-chat).

Di antara itu, satu baris progres yang ditulis dari checklist-nya ("3 dari 8 langkah selesai"), paling sering tiap
setengah jam, dan cuma kalau ada langkah yang selesai. Kalau ia menunggu kamu, ia mengingatkan sekali lagi setelah empat
jam.

## Memantaunya

**Missions** di dashboard menampilkan yang butuh kamu paling atas, lalu yang sedang jalan, lalu yang sudah selesai,
masing-masing dengan progres checklist-nya: satu tab untuk tiap kelompok, pencarian di tujuan, laporan dan ID-nya,
filter per agent, dan seberapa jauh ke belakang yang sudah selesai ditampilkan: 3, 7, 14 atau 30 hari terakhir (3 kalau
tidak dipilih), tidak lebih. Misi yang masih terbuka selalu tampil, berapa pun umurnya. Halaman satu misi menunjukkan langkah, giliran, jam dan token terhadap
batasnya, langkah yang sedang ia kerjakan saat itu juga, checklist dengan catatan tiap langkah, panggilan yang
diparkir untuk kamu (bisa dijawab langsung di sana), pertanyaannya, laporan dan file-nya di bagian atas begitu ada,
dan setiap gilirannya sebagai timeline, yang terbaru di atas, masing-masing ditandai apa yang memulainya (langkah
berikutnya, jawaban agent lain, job selesai, approval, coba lagi) dan bagaimana hasilnya, dengan jeda sebelumnya, dan
kegagalan yang sama berturut-turut ditampilkan sekali. Stop, Continue, Accept dan Answer muncul kalau berlaku, dan
**Accept as it is** di misi yang menunggu hal lain. Selama misinya masih terbuka, **Tell it** menerima pesan untuknya, dan
menampilkan apa saja yang sudah disampaikan berikut sudah dibaca atau belum.

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

Batas pemakaian, rate limit, provider yang sedang down: misinya **berhenti sebentar** dan mencoba lagi sendiri,
setelah 2, 10 dan 30 menit, lalu tiap jam, selama kira-kira sehari. Kamu diberi tahu sekali waktu ia berhenti dan sekali
waktu ia jalan lagi; waktu menunggunya gak dihitung ke batas jamnya. **Retry now** mencoba saat itu juga, **Stop**
mengakhirinya. Setelah sehari, misinya bertanya ke kamu.

## Approval

Misi gak berhenti di satu pertanyaan. Panggilan yang butuh approval kamu **diparkir**: promptnya datang ke chat kamu,
misi jalan terus dengan apa pun yang gak bergantung padanya, dan jawaban kamu (kapan pun dalam sehari) jadi giliran
berikutnya. Ia menunggu kamu begitu satu giliran gak menyelesaikan satu langkah pun (mengecek approval bukan kemajuan), dan misi
yang berakhir menarik apa yang ia parkir. Ia jalan di level approval kamu, atas nama kamu.

## Batas

| | Default | Yang dibatasi |
|---|---|---|
| `per_agent` | 1 | misi yang bekerja bersamaan untuk satu agent; yang sedang dicek tidak dihitung, karena pemeriksanya bukan agent itu. Tiap agent bisa punya angkanya sendiri, 1 sampai 4 |
| `max_running` | setengah jumlah agent, 1 sampai 8 | misi yang jalan bersamaan di box |
| `limit_hours` | 8 | jam kerja; waktu menunggu kamu gak dihitung |
| `limit_turns` | 100 | giliran (tiap giliran sampai `max_tool_iterations` langkah), termasuk milik pemeriksa dan cek yang gagal |
| `limit_tokens` | 100.000.000 | token input dan output, termasuk milik pemeriksa |

Semuanya ada di `[missions]` di `config.toml`, dan di **Limits** pada halaman Missions di dashboard, tanpa restart. Misi mengambil batasnya saat dimulai. Misi
yang menunggu kamu gak memakai slot; yang berikutnya menunggu di antrean dan bilang sedang menunggu apa.

**Jumlah misi bersamaan untuk satu agent** diatur di halaman Settings agent itu, **Missions at once**, atau
`[missions] per_agent` di `config.toml` miliknya sendiri: tiga untuk agent yang mengerjakan pekerjaan panjang, satu
untuk yang lain. `max_running` milik box tetap membatasi semuanya, jadi naikkan juga. Dua misi di satu repo tetap
bergantian, berapa pun angkanya: mereka bisa saling menimpa file.

Kalau `max_running` gak diisi, nilainya ikut agent yang aktif: setengahnya, dibulatkan ke bawah (satu di box dengan
satu atau dua agent, tiga di box dengan enam agent), dan gak pernah lebih dari delapan. Isi sendiri kalau mau lebih,
sampai sebanyak semua agent. Di form Limits, kotak yang kosong berarti default-nya, yang tampil abu-abu; **Back to
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
(lihat di bawah), dan folder yang diberikan itu gak pernah dihapus. Waktu berakhir, ia dicatat sekali di memori
agent-nya, dari laporannya.

Misi punya percakapan sendiri, bukan percakapanmu: `/new`, `/reset` atau menghapus chat tempat ia dimulai gak
menghentikannya, dan ia tetap melapor ke sana. Percakapan itu ada di halaman misinya, bukan di daftar Chat. Setelah
berakhir, misi disimpan selama percakapan disimpan, `[retention] session_days` (30 hari), lalu dihapus; misi yang
masih berjalan gak pernah dihapus, selama apa pun ia berjalan.

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
| `/mission <tujuan>` | mulai satu untuk agent yang kamu sapa |
| `/mission` | yang jalan dan menunggu di sini, yang butuh kamu paling atas |
| `/mission stop <id>` | akhiri |
| `/mission continue <id> [catatan]` | lanjut melewati batas, keluar dari macet, atau dengan apa yang kurang setelah dicek |
| `/mission accept <id>` | terima hasilnya, atau usulan, yang lalu mulai; di misi yang menunggu hal lain, terima apa adanya |
| `/mission accept <id> --outside "<di mana>"` | tutup sebagai selesai lewat jalan lain, cek-nya gak dijalankan |
| `/mission answer <id> <jawaban>` | jawab pertanyaannya |
| `/mission tell <id> <pesan>` | sampaikan sesuatu saat ia bekerja; dibaca sebelum langkah berikutnya lalu diikuti, bukan tujuan baru |

Id-nya yang pendek seperti di notifikasi, `msn_3f2a91`. Di grup, orang yang memulai misi atau admin yang bisa
mengaturnya. Dari shell: `nouride mission [list|show|stop|continue|accept|answer|tell]`.
