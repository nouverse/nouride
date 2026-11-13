---
title: Skill & pembelajaran
description: Agent kamu mencatat apa yang berhasil dipecahkannya, dan kamu yang memutuskan mana yang disimpan.
---

Agent yang memecahkan masalah yang sama dua kali gak belajar apa-apa. Agent Nouride membuat catatan,
dan secara default kamu menyetujui apa yang mereka pelajari sebelum itu berlaku.

Catatan itu disebut **skill**. Sebuah skill adalah dokumen pendek: cara mengerjakan satu jenis
pekerjaan, urutan langkahnya, dan hal-hal yang biasa salah. Sebelum memulai sebuah pekerjaan, agent
membaca skill yang tampak relevan, jadi satu pelajaran yang ditulis sekali tersedia sejak saat itu, di
setiap platform, bagi setiap agent yang menyalakan skill itu.

![Skills Workshop](/media/dashboard-skills.png)

## Satu kumpulan, sakelar per agent

Ada **satu** kumpulan skill di `.nouride/agents/skills/`, dan semua agent ditawari seluruhnya.
Pengecualian milik satu agent tinggal di `skills.toml` di sebelah pack-nya:

```toml
[skills]
document-authoring = false     # mati hanya untuk agent ini
```

Menyala secara default, bukan daftar opt-in, karena daftar yang ditulis hari ini gak bisa menyebut
skill yang datang bulan depan, setiap skill berikutnya akan muncul dalam keadaan mati tanpa penjelasan
apa pun.

Pengecualiannya adalah skill yang frontmatter-nya menyebut agent-agentnya di baris `agents:`. Skill itu
mati untuk setiap agent yang gak disebut di sana, sampai `skills.toml` milik agent itu menyalakannya.
Skill learning menulis baris itu di setiap skill baru, berisi agent yang mempelajarinya, supaya
pelajaran dari satu agent gak nyelonong masuk ke prompt semua agent lain tanpa diminta.
`nouride skills on <skill> <agent>` memberikannya ke agent lain.

Empat cara membalik sakelar itu, semuanya menulis file yang sama: Skills Workshop, tab **Skills**
milik agent, CLI, dan agent sendiri lewat `skill_toggle`.

```bash
nouride skills                  # apa yang ditawarkan ke tiap agent, dan kapan tiap skill terakhir dibaca
nouride skills nouva -v         # satu agent, dengan deskripsi dan path tiap skill
nouride skills --all            # seluruh kumpulan: siapa punya apa, dan software apa yang kurang
nouride skills off document-authoring nouva
nouride skills on  document-authoring nouva
```

Sebuah skill datang dari salah satu dari tiga tempat, dan tab **Skills** milik agent melabeli tiap
barisnya:

| | |
|---|---|
| **Built in** | ikut bersama Nouride, di direktori `skills/` di samping binary, dan diperbarui bersamanya |
| **Shared** | kumpulan bersama, apa yang kamu dan para agent tulis. Skill kumpulan yang bernama sama dengan skill bawaan mengalahkannya |
| **Project** | sebuah `SKILL.md` di bawah `.agents/skills/` dalam direktori yang disebut di `[workspace] skill_roots` agent itu. Dibaca ulang setiap giliran, jadi skill yang ditambahkan ke repository berlaku sejak pesan berikutnya. Skill di sana yang berupa link ke folder lain di dalam direktori yang sama ikut dimuat |

Folder project milik sebuah agent, `skill_roots`-nya, ada di tab **Skills** agent itu sejak 0.8.24: tiap folder beserta
skill yang dibawanya, ditambah lewat path-nya dan dihapus di sana oleh admin. `nouride agent skill-root add|rm <id>
<path>` melakukan hal yang sama dari terminal. Foldernya dicek dulu: folder yang bisa dibuka daemon, bukan folder yang
memuat folder kredensial, bukan folder yang sudah dimiliki agent itu. Perubahannya disimpan seperti tab Files menyimpan
`config.toml` agent itu, versi sebelumnya disimpan, agent-nya dimuat ulang. Agent juga bisa meminta folder sendiri
lewat tool `skill_root`: admin menyetujui atau menolaknya di chat, di setiap level approval, `trusted` juga, karena skill
sebuah project jadi instruksi yang diikuti agent itu.

`[skills] off` di config daemon adalah sumbu yang lain: nama yang gak dimuat siapa pun, apa pun isi
`skills.toml` mereka. Itu penghapusan, bukan preferensi, dan ada terutama untuk skill bawaan, yang gak
bisa dihapus. **Switch off for every agent** di sebuah baris Workshop yang menulisnya.

## Bawaan

Skill-skill ini ikut bersama Nouride dan diperbarui bersamanya. Skill yang ditambah, dihapus atau diubah di folder
bawaan atau di kumpulan sampai ke semua agent dalam semenit, tanpa restart (sejak 0.8.13).

- **document-reading**: isi sebuah PDF, Word, Excel, PowerPoint, EPUB atau dokumen hasil scan. Satu
  skrip bantu mengenali jenis file yang sebenarnya, mendaftar sheet, judul bagian atau halamannya,
  mengeluarkan bagian mana pun ke file, dan menjawab pertanyaan atas sheet besar dengan SQL. Butuh
  `python3`.
- **document-authoring**: PDF hasil typesetting dengan LaTeX, seperti paper, laporan, tesis, surat
  atau CV; dan perubahan pada workbook Excel yang sudah ada lewat skrip yang mengedit salinannya,
  tidak pernah aslinya, dan menolak workbook yang akan rusak karenanya.
- **nouride**: mengoperasikan daemon itu sendiri. Meng-upgrade-nya, me-restart-nya, menambah koneksi
  atau provider, mencari tahu kenapa salah satunya mati, dan menambah agent dari chat: model Nouride atau CLI
  coding, ditanyakan satu per satu.
- **network-reach**: menemukan dan menjangkau perangkat lain di jaringan kamu atau lewat Tailscale,
  dengan panduan setup untuk Windows, macOS, Android, kamera, NAS dan lainnya ketika ada yang harus
  dinyalakan di perangkatnya.
- **share-preview**: link publik trycloudflare.com ke sesuatu yang dibangun agent, tanpa akun dan tanpa
  membuka port.
- **mockup-design**: mockup sebuah layar, halaman atau aplikasi, ditulis sebagai HTML dan digambar di
  browser sungguhan pada lebar desktop dan lebar HP, diukur dan dilihat dulu sebelum dikirim. Ia bertanya
  dulu kamu mau bentuk apa: link yang bisa dibuka, gambar, gambar di dalam HP dan laptop, atau file
  HTML-nya. Ia gak punya gaya sendiri: warna dan font datang dari kamu, brand kamu, atau dipilih untuk
  permintaan itu.
- **carousel**: satu set gambar untuk digeser di Instagram, LinkedIn atau TikTok. Ia bertanya dulu mau
  diposting di mana, yang menentukan bentuknya, lalu mengirim kata-katanya slide demi slide untuk kamu
  iyakan sebelum menggambar apa pun. Semua slide ada di satu file HTML, digambar pada ukuran persis
  platformnya, diukur untuk layar HP dan dilihat dulu sebelum dikirim, sebagai satu album berurutan atau
  sebagai PDF. Ia juga gak punya gaya sendiri.
- **motion-graphics**: video yang dibuat dari kode dengan Remotion. Ia lebih dulu memeriksa apakah mesin
  ini sanggup me-render-nya, dan me-render di perangkat kamu yang lain lewat network-reach kalau gak
  sanggup. Ia bertanya videonya ditonton di mana, yang menentukan bentuknya (layar biasa, layar HP penuh
  untuk Reels atau TikTok, postingan feed), dan untuk feed ia menaruh kaitnya di depan, satu gagasan per
  adegan, kata-katanya di layar cukup lama untuk dibaca, dan kartu penutup. Tiap putaran diukur selain
  dilihat: teks kekecilan, teks di tempat aplikasi HP menimpa video vertikal, dan teks yang terlalu pucat.
- **browser-automation**: browser sungguhan yang dikendalikan dengan Playwright untuk login, menelusuri
  dan mengisi situs. Ia bertanya dulu sebelum apa pun yang gak bisa dibatalkan, dan mengubah alur yang
  berhasil jadi script yang bisa jalan lagi sendiri.
- **nouclip**: ringkasan sebuah video atau link YouTube dari transkrip bertimestamp, dan klip vertikal
  pendek dengan subtitle per kata, yang memakai caption video itu sendiri sebelum mentranskrip apa pun.
- **coding-agents**: pekerjaan coding yang diserahkan ke coding agent CLI seperti OpenCode, Claude Code,
  Codex, Gemini CLI atau pi. Agent memasangnya tanpa root, login-kan ke provider yang sudah dipakainya
  atau dengan token langganan, menjalankannya di worktree sendiri, melanjutkan di sesi yang sama, dan
  memeriksa diff serta tesnya sebelum melapor.

Untuk mengubah salah satunya, salin ke kumpulan dengan nama yang sama dan sunting salinannya, yang
kemudian menang. Menyunting file bawaannya cuma buang tenaga: upgrade berikutnya menggantinya, dan
agent yang mencobanya ditolak.

Skill milik [agent eksternal](/id/docs/manual/external-agents/), yang dinyalakan untuknya, disalin ke folder skill
milik CLI-nya, untuk Claude Code dan Codex; skill yang butuh tool Nouride yang gak bisa dipanggil CLI itu gak ikut
disalin. CLI yang kamu tambahkan sendiri gak dapat skill. Sejak 0.8.9 skill project dari `skill_roots`-nya ikut
disalin, ulang sebelum tiap giliran, jadi skill yang ditambahkan ke repository sampai ke CLI di pesan berikutnya, di
folder mana pun ia bekerja.

## Dari mana skill datang

Empat jalan masuk.

**Orang lain yang menulisnya.** Skill yang mengikuti format terbuka [Agent Skills](https://agentskills.io)
bisa dipasang dari hub: tab **Explore** di halaman Skills, `nouride skills search` /
`nouride skills install`, atau agent yang memintanya lewat `skill_search` / `skill_install`.

| Sumber | Pasang dengan |
|---|---|
| GitHub | `owner/repo`, `owner/repo/path/ke/skill`, atau URL github.com. Memasang semua skill di dalamnya |
| [skills.sh](https://skills.sh) | `skills.sh:owner/repo/skill` |
| [ClawHub](https://clawhub.ai) | `clawhub:slug`. Hasil scan keamanannya ditampilkan, dan vonis *malicious* ditolak |
| `/.well-known/skills/` sebuah situs | `well-known:https://situs` |

Memasang berarti skill diambil, dikunci (ke commit atau versi), lalu disesuaikan dengan Nouride:
frontmatter YAML diratakan, `allowed-tools` menjadi `needs_tools` (`Bash` → `exec`, `Read` → `read`…),
dan `requires` diisi dari bahasa script-nya. File biner dan path yang gak aman ditinggalkan. Setelah itu
ia menunggu di **Pending** seperti draft lain, dengan asal dan apa saja yang diubah di sampingnya. Belum
ada yang masuk ke prompt agent, dan belum ada script yang jalan, sampai kamu menyetujuinya. Skill yang
disetujui menyimpan baris `source:` yang menyebut asalnya. Set secret `github_token` kalau batas GitHub
60 request per jam mengganggu.

**Kamu menulisnya.** Tambahkan direktori berisi `SKILL.md` ke `agents/skills/`, atau minta agent
menyimpan sebuah prosedur: ia menuliskan apa yang kamu diktekan lewat `skill_create`, langsung ke
kumpulan, menyala untuk agent itu. Ia diperiksa sama seperti draft, jadi prosedur yang menyebut alamat,
akun, atau sesi yang sudah lewat dikembalikan untuk ditulis ulang. Tool itu ditahan approval seperti
`write`, jadi ditanya dulu atau gak mengikuti [tingkat approval](/id/docs/manual/approvals/) kamu.

**Agent membetulkan skill yang sedang dipakainya.** Agent yang menemukan sebuah skill salah atau kurang
di tengah tugas mengusulkan perbaikannya lewat `skill_improve`. Gak ada yang berubah sampai kamu
menyetujuinya: perbaikannya datang sebagai draft.

**Agent mempelajarinya sendiri.** Itulah **skill learning**, isi sisa halaman ini.

## Apa yang membuatnya menengok ke belakang

Gak ada yang berjalan pada giliran biasa, itu akan lambat dan mahal. Prosesnya satu panggilan model
pendek untuk memutuskan, ditambah satu lagi untuk menulis draft kalau memang ada yang ditulis, dan ia
cuma berjalan setelah giliran di mana sesuatu benar-benar terjadi:

- **Kamu memintanya.** "Simpan ini sebagai skill."
- **Sesuatu gagal lalu berhasil.** Tiga kegagalan tool dalam satu giliran, lalu sukses. Kegagalannya
  itulah yang membuatnya layak dicatat.
- **Percakapannya jadi panjang dalam usaha.** Delapan putaran model. Satu giliran bernilai satu,
  ditambah satu untuk tiap putaran penggunaan tool, ditambah satu lagi kalau balasan kamu datang dalam
  tiga menit sejak kata terakhir agent, begitulah "kamu sedang mengarahkan" dihitung tanpa membaca satu
  kata pun.
- **Ia berhasil menjalankan sesuatu yang baru**: tool yang belum pernah berhasil dipakai agent ini.

Semua ini soal *bentuk* dari apa yang terjadi, bukan maknanya. Belum ada yang dinilai. Angka-angkanya
milik daemon sendiri, bukan pengaturan.

Daemon juga sengaja gak mencoba menilainya. Versi sebelumnya mencocokkan frasa seperti "masih
error", yang gagal diam-diam bagi siapa pun yang pilihan katanya gak terantisipasi. Menghitung itu
bodoh, gratis dan gak bergantung bahasa; penilaiannya milik model. Yaitu model milik agent itu, kecuali
`[skills.learning] model` menyebut yang lebih murah.

## Apa yang diputuskannya

Agent membaca ulang percakapannya dan bertanya satu hal: **apakah pustaka skill harus berubah karena
ini?**

Yang dicarinya adalah prosedur. Ada tiga tempat untuk menyimpan apa yang dipelajari agent, dan cuma
satu yang berupa skill:

| | |
|---|---|
| **Work notes** | Satu tugas selagi berjalan: rencananya, sudah sampai mana, apa yang ditemukan. Ikut bersama tugasnya. |
| **Memory** | Fakta tentang orang dan tentang lingkungan ini: host mana menjalankan apa, alamatnya, akun dan path-nya. |
| **Skill** | Prosedur untuk satu *jenis* tugas: langkah yang diikuti agent saat mengerjakan hal serupa lain kali, di tugas lain dan mungkin di mesin lain. |

Ujiannya: apakah agent yang mengerjakan tugas lain dari jenis yang sama bakal mengikuti langkah ini?
File tugas ini, angka-angkanya, dan perbaikan untuk yang rusak hari ini masuk ke notes-nya atau ke
memory. Sebuah insiden cuma dapat satu baris di skill, sebagai langkah yang mencegahnya lain kali.

Empat kemungkinan jawaban, yang pertama cocok yang dipakai:

| | |
|---|---|
| **Update** | Sudah ada skill yang mencakupnya. Tambahkan langkah atau jebakan yang hilang. |
| **Attach** | Ada skill yang mencakupnya, tapi yang dipelajari besar, perintah panjang, config yang berhasil, sebuah error dan sebabnya. Taruh di file di sebelah skill, jangan menggelembungkan skill-nya. |
| **Create** | Belum ada yang mencakup jenis pekerjaan ini. Usulkan skill baru, dan sebutkan mana yang paling mendekati, dan kenapa gak sebaiknya diserap ke situ. |
| **Skip** | Memang gak ada apa-apa di sini. |

Skip itu nyata, dan seharusnya jarang setelah sesi panjang. Kalau kamu menghabiskan satu sore
menyambungkan sebuah kamera dan sekarang berhasil, *kamera*-nya memang kasus satu kali, tapi
*prosedurnya* gak.

**Jenis pekerjaan baru dicatat dulu sebelum ditulis.** Satu percakapan belum membuktikan pekerjaan itu
bakal datang lagi. Jadi pertama kali, sebuah create ditahan sebagai **kandidat**: nama dan baris "Use
when", tanpa isi dan tanpa panggilan model kedua. Skill-nya baru ditulis ketika percakapan lain ternyata
jenis pekerjaan yang sama, atau langsung saat itu juga kalau ada orang yang meminta skill dengan
kata-kata. Kandidat yang gak muncul lagi dalam 30 hari gugur.

## Seberapa banyak yang berjalan tanpa kamu

`[skills.learning] mode`, atau panel **Self-Improving Skill** di bagian atas halaman Skills, yang berlaku
sejak pesan berikutnya. `ask` adalah default-nya.

![Panel Self-Improving Skill: seberapa banyak yang berjalan tanpa Anda, model-nya, dan review mingguan](/media/skills-learning.png)

**`ask`: usulkan, lalu tunggu saya.** Draft adalah usulan, bukan perubahan. Draft yang menunggu
dipasang di puncak halaman Skills. Masing-masing menunjukkan apa yang ingin ditambahkan agent,
alasannya, dan, untuk sebuah update, diff baris per baris terhadap file di disk, karena perbaikan
biasanya satu jebakan tambahan di dalam badan enam puluh baris, dan meminta orang menemukannya dengan
mata sama saja meminta mereka menyetujui tanpa membaca. Draft baru juga diumumkan di chat asalnya,
kecuali `[skills.learning] notify_chat` dimatikan.

**`off`: gak ada yang diperiksa.** Draft yang sudah menunggu tetap di tempatnya, tetap kamu yang
memutuskan. Tinjauan mingguan juga gak jalan sendiri.

**`auto`: biarkan ia menyimpan apa yang dipelajarinya.** Agent menyetujui draft-nya sendiri saat
menulisnya dan memberi tahu kamu sesudahnya di chat tempat ia bekerja. Yang perlu diketahui sebelum
memilih ini: sebuah skill dibaca pada setiap giliran yang cocok oleh setiap agent yang menyalakannya,
jadi yang buruk salah berulang kali dan diam-diam, bukan sekali dan kelihatan. Skill baru mulai dalam
keadaan menyala hanya untuk agent yang mempelajarinya, jadi skill yang buruk tertahan di satu agent
sampai ada yang menyalakannya di tempat lain. Yang kamu punya sesudahnya adalah audit log, barisnya
mencatat daemon sebagai penyetuju, dan `nouride skills off <skill> <agent>` untuk menariknya keluar.
Ini cuma mencakup draft milik loop sendiri: skill dari hub, perbaikan `skill_improve`, dan setiap
usulan dari tinjauan mingguan tetap menunggu kamu.

Nilai yang gak dikenali pada pengaturan itu dibaca sebagai `ask`, gak pernah sebagai `auto`: nilai
salah seharusnya berbiaya satu approval, bukan memberi otonomi.

Sebelum 0.7.27 tabelnya bernama `[rsi]`, dan mode-nya `require_approval` (sekarang `ask`) dan
`always_allow` (sekarang `auto`). Sejak 0.8.0 tabel `[rsi]` di `config.toml` membuat daemon gak mau
start, sambil menyebut `[skills.learning]`.

## Menggarap antreannya

```bash
nouride skills drafts            # apa yang menunggu kamu
nouride skills draft <id>        # satu draft utuh, beserta giliran asalnya
nouride skills approve <id>      # masuk ke kumpulan
nouride skills deny <id>         # dibuang, beserta transkripnya
```

`approve` dan `deny` juga menerima nama skill-nya. Atau `/drafts` di chat, di mana `/drafts approve`
tanpa apa-apa lagi menyetujui semua yang menunggu, atau Skills Workshop, yang tab-tab-nya adalah satu
alur kerja:

| Tab | Menampilkan |
|---|---|
| **Live** | kumpulannya: apa yang benar-benar dibawa para agent. Dibuka duluan kalau tidak ada yang menunggu kamu |
| **Pending** | antreannya, plus yang baru-baru ini diputuskan. Dibuka duluan kalau ada yang menunggu kamu |
| **Explore** | skill di hub, dibuka dengan yang paling banyak diunduh di ClawHub. Memasang salah satunya menaruhnya di Pending |

Setiap baris draft terbuka menjadi `SKILL.md` utuh, bisa disunting di tempat, plus transkrip giliran
asalnya yang sudah dibersihkan, atau, untuk skill dari hub, asalnya dan apa saja yang disesuaikan.
Keduanya ada di baris itu, bukan di balik navigasi, karena keputusannya adalah "apakah saya mau ini ada
di prompt agent saya" dan buktinya adalah giliran itu.

**Draft bukan approval.** Ia gak menghalangi apa pun dan gak pernah kedaluwarsa. Karena itu ia
tinggal di Workshop dan bukan di antrean approval, menyatukan keduanya akan memberi salah satunya
siklus hidup yang salah.

## Tinjauan mingguan

Skill learning cuma menambah, dan pustaka yang terus tumbuh ujung-ujungnya berisi skill yang badannya sudah
jadi log insiden, dua skill untuk satu topik, dan skill yang gak pernah dibaca. Jadi seminggu sekali,
selama mode-nya bukan `off`, daemon membaca seluruh pustaka dan mengusulkan tiga jenis perubahan:

| | |
|---|---|
| **Tighten** | Badan lebih dari 12.000 karakter, atau yang menyebut alamat sebuah mesin atau sebuah akun, atau menceritakan satu sesi. Hasil tulis ulangnya harus lebih pendek, atau bersih dari yang ditemukan, kalau gak ya dibuang. |
| **Merge** | Skill-skill yang mencakup satu topik, ditemukan lewat satu panggilan model atas nama dan deskripsinya. Satu ditulis ulang untuk menampung semuanya; sisanya diarsipkan saat kamu menyetujuinya. |
| **Archive** | Skill yang gak dibaca siapa pun selama 45 hari, dan umurnya lebih dari itu. Tanpa panggilan model. Setiap bacaan disimpan selama skill-nya ada, jadi skill baru dihitung gak terbaca setelah diamati selama itu. Ia dipindah ke `skills/.archive/`, dan memindahkannya balik membatalkannya. |

Cuma skill yang ditulis agent yang disentuh. Skill tulisan orang dan skill bawaan gak pernah. Setiap
usulan adalah draft yang menunggu kamu di mode apa pun, termasuk `auto`: menulis ulang atau memindahkan
sesuatu yang diandalkan agent-agent kamu itu keputusan, bukan pelajaran. Di **Pending** draft-draft ini
ditandai **weekly review**, dan barisnya bilang apa yang dipindah kalau disetujui: **archives**, atau
**merges** beserta nama-nama yang diserapnya.

`nouride skills review`, atau **Review now** di panel Self-Improving Skill, menjalankannya saat itu juga.
Panelnya menampilkan kapan tinjauan terakhir jalan dan apa yang diusulkannya.

## Dua hal yang gak boleh dilakukan agent

Apa pun mode yang kamu pilih:

- **Mengubah skill yang ditulis orang.** Skill yang kamu tambahkan manual gak punya agent di baris
  `author:`-nya, dan baik loop maupun tinjauan mingguan gak pernah mengusulkan perubahan untuknya.
  Agent yang menemukannya salah bilang begitu di balasannya, dan suntingannya tetap urusan kamu. Skill
  bawaan juga terlarang dengan cara yang sama.
- **Menghapus sebuah skill.** Hanya manusia yang menghapus. Tinjauan mingguan bisa mengusulkan
  mengarsipkan skill yang ditulis agent, dan gak ada yang dipindah sampai kamu menyetujuinya.

## Pagar pengaman

**Ia gak akan membanjiri kamu.** Dua puluh draft yang menunggu adalah batasnya. Setelah tercapai, loop
berhenti mengusulkan sampai kamu membersihkan sebagian. Draft baru untuk skill yang sudah punya draft
menunggu akan menggantikannya dan membawa pelajaran sebelumnya, jadi antrean memuat satu keputusan,
bukan beberapa yang saling menimpa.

**Kredensial dibuang.** Token, key dan password dibersihkan dari percakapan sebelum agent membacanya
ulang, dan sekali lagi sebelum apa pun ditulis ke disk.

**Draft diperiksa oleh kode.** Prompt-nya sudah meminta semua ini, dan meminta saja gak cukup. Draft
ditolak sebelum sampai ke kamu kalau badannya menyebut alamat sebuah mesin, alamat hardware (MAC) atau
akun email, atau menceritakan satu sesi ("in this session", "the user said") alih-alih menulis
prosedurnya. Ia juga ditolak kalau deskripsinya berbunyi seperti catatan suntingan ("Update…",
"Document…") dan bukan kapan skill itu dipakai, dan kalau badan skill baru lebih dari 8.000 karakter.
Revisi boleh menumbuhkan badan sampai 12.000 karakter; badan yang sudah lewat dari itu gak boleh
bertambah panjang. Penolakan dicatat di log dan di audit log.

**Skill ditulis dalam bahasa Inggris**, apa pun bahasa yang kamu pakai. Satu pustaka, satu bahasa,
supaya agent mana pun bisa membaca skill mana pun.

**Ia menunggu sebelum menengok lagi.** Satu menit di antara dua kali menengok untuk agent yang sama,
nyaris sama dengan mati: yang seharusnya membatasi refleksi adalah jumlah kerja, dan pemicu di atas
sudah menghitungnya. Meminta sebuah skill dengan kata-kata mengabaikan jeda maupun batasnya; orang yang
bertanya bukan derau.

## Skill yang bagus itu seperti apa

Dinamai menurut *kelas* pekerjaannya, bukan kejadian hari ini. `deployment-docker`, bukan
`benerin-build-hari-selasa`. Kalau namanya cuma masuk akal hari ini, itu nama yang salah, dan agent
diinstruksikan untuk lebih dulu memperbarui skill yang ada sebelum mengarang yang baru, karena dua
skill untuk satu topik lebih buruk daripada salah satunya sendirian: agent memuat yang satu, pelajaran
ada di yang lain, dan keduanya jadi gak dipercaya.

Isinya prosedur, bukan riwayat. Perbaikan masuk ke langkah yang diubahnya dan digabung dengan jebakan
yang sudah tercatat, bukan ditempel di akhir, dan insiden bertanggal dibuang. Fakta tentang lingkungan
ini juga gak masuk: skill-nya menulis `<host>` atau "the Docker host", dan memory yang mencatat mesin
mana itu.

Setiap skill juga menyatakan apa yang dibutuhkannya, program yang harus terpasang, tool yang harus
diizinkan. `nouride doctor` melaporkan kedua kesenjangan itu, per mesin dan per agent, karena
alternatifnya adalah skill yang termuat baik-baik saja lalu mati di langkah empat dengan
`dot: command not found`, di tengah tugas, dengan satu approval sudah terpakai.

## Skill itu ada biayanya

Setiap skill memakan satu baris di system prompt *setiap* agent yang menyalakannya, pada *setiap*
giliran, dibaca atau gak. `nouride doctor` mendaftar skill yang belum ada catatan dibacanya justru
karena itu. Ia melaporkannya sebagai wajar, bukan
sebagai kesalahan: skill yang gak terbaca adalah tagihan yang layak diketahui, bukan bug. Untuk skill
yang ditulis agent, tinjauan mingguan melangkah lebih jauh dan mengusulkan mengarsipkannya setelah 45
hari gak dibaca.
