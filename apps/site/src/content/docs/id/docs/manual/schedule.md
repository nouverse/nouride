---
title: Tugas terjadwal
description: Cron job, pengingat, sekali jalan, dan webhook, hal yang terjadi tanpa ada yang mengetik.
---

Scheduler membangunkan agent ketika gak ada yang mengajaknya bicara. Empat bentuk pemicu, satu tabel
job.

| | |
|---|---|
| **Cron** | ekspresi crontab, `0 9 * * *` |
| **Every** | interval, `15m`, `2h` |
| **At** | sekali, pada suatu waktu, `2h` dari sekarang, atau sebuah timestamp |
| **Webhook** | saat sebuah URL dipanggil, bukan saat jam tertentu |

![Halaman Schedule](/media/dashboard-schedule.png)

Halaman **Schedule** di dashboard mencakup tiga yang pertama dan **Webhooks** yang keempat. Keduanya
job yang sama dilihat dari dua sisi yang penting: apa yang menyala karena jam, dan apa yang menyala
karena dipanggil sesuatu. Schedule menampilkan semua job, bisa difilter aktif, dijeda, atau gagal, dan
di sanalah kamu membuat, mengubah, menjalankan, menjeda, dan menghapusnya. Atau minta saja ke agent:
"ingatkan aku cek deploy dua jam lagi", lalu agent [mengusulkan](#diminta-ke-agent) job-nya, dan kamu yang
menyalakannya.

Schedule berlaku daemon-wide, bukan per agent, meskipun setiap job punya pemilik, karena biasanya kamu
ingin melihat semua yang terjadwal sekaligus.

## Dari CLI

```bash
nouride cron                     # yang terjadwal dan aktif
nouride cron --all               # termasuk yang dinonaktifkan
nouride cron run <id>            # jalankan sekarang
nouride cron runs <id>           # riwayatnya
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
| `--cron "0 9 * * *"` / `--every 15m` / `--at 2h` | pilih tepat satu |
| `--tz <zona>` | jam mana yang dipakai membaca jadwalnya |
| `--agent <id>` | agent yang memilikinya. Dari panggilan agent sendiri, agent itu |
| `--gateway <id> --chat <id>` | ke mana hasilnya dikirim. Wajib dari terminal; dari panggilan agent sendiri, percakapannya |
| `--message <prompt>` | bangunkan agent dengan ini |
| `--text <pesan>` | kirim teks biasa. Tanpa panggilan model, tanpa biaya |
| `--command <shell>` | jalankan sebuah perintah. Tanpa panggilan model |
| `--then agent` | …lalu bangunkan agent dengan apa yang dicetaknya, kalau ia mencetak sesuatu |
| `--mission <goal>` | jalankan setiap kali sebagai mission. Dengan `--check <perintah>` untuk satu cek, `--no-review` tanpa reviewer; cek lebih banyak dari dashboard |
| `--session <fresh\|isolated\|chat>` | riwayat apa yang dilihat giliran itu |
| `--quiet` | gak mengirim apa pun, termasuk kabar gagal; hasilnya tetap ada di `nouride cron runs` |
| `--keep` | simpan job sekali-jalan setelah menyala: dimatikan, dan tercatat sebagai `fired` |

`nouride cron update <id>` menerima `--name`, flag jadwal, `--tz`, `--text`, `--message` dan
`--agent`.

### Empat jenis job, dan biayanya

**`--text`** adalah pengingat biasa. Gak ada model yang dipanggil, jadi gratis. Pakai ini kapan pun
pesannya memang intinya.

**`--command`** menjalankan satu baris shell dan mengirim output-nya. Juga tanpa panggilan model.
`--then agent` menambahkan satu: agent membaca output-nya lalu melaporkan, dan itulah bedanya antara
"ini pemakaian disk" dengan "disk mulai penuh, ini yang memakannya". Run yang tidak mencetak apa pun
tidak mengirim apa pun, dan dengan `--then agent` tidak membangunkan siapa pun: cek yang hanya mencetak
saat ada masalah tidak memakan biaya selama semuanya baik. Perintah yang gagal tetap dikabarkan di chat.

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
**mengusulkan** job-nya lewat tool `schedule`. Agent menulis job-nya lengkap, membiarkannya mati, dan
mengirim kartu ke chat:

```
📋 nouva proposes a scheduled job: Customer mail
When: cron `0 9 * * 1` (Asia/Jakarta)
Does: a mission for nouva: "Sum up last week's customer mail for the team.", then a reviewer agrees
Results: here
It stays off until somebody turns it on.          [Turn on] [Discard]
```

Gak ada yang jalan sebelum ada yang menjawab. **Turn on** menyalakan jadwalnya, dan mission-nya jalan
atas nama orang yang menekannya. **Discard** membuang usulannya. Di chat satu lawan satu, orang di chat
itu yang menjawab; di grup, orang yang meminta atau admin. Kalau chat-nya gak punya tombol, seperti
WhatsApp, kartunya menyebut perintahnya: `/schedule on <id>` dan `/schedule discard <id>`. Halaman
Schedule dan Webhooks menampilkan usulan dengan dua tombol yang sama, dan kartu yang dijawab dari sana
ikut berubah di chat.

Agent gak pernah menyalakan job sendiri, memperluasnya, atau mengubah job yang sedang jalan. Perubahan
adalah usulan baru yang menyebut job yang diganti; setelah dinyalakan, job itu berubah bentuk tapi tetap
memakai id, riwayat run, dan URL webhook-nya. Agent yang menjalankan `nouride cron add`, `update` atau
`enable`, atau `webhook add` atau `rotate`, ditolak dan diarahkan ke `schedule`. Paling banyak sepuluh
usulan dari satu agent yang boleh menunggu sekaligus, dihitung dari agent yang mengusulkannya.

Yang menjawab usulan cuma orang, gak pernah agent. Ada yang cuma bisa dinyalakan admin, siapa pun yang meminta:
perubahan pada job milik agent lain, perubahan pada job yang melapor ke chat lain, dan webhook, sama seperti
membuatnya. Izin *allow always* milik job lama gak ikut ke bentuk barunya: ia bertanya lagi.

## Webhook

Endpoint yang menjalankan sebuah job ketika ada yang memanggilnya.

![Sebuah webhook: URL-nya, cara memanggilnya, apa yang dijalankan dan ke mana balasannya](/media/dashboard-webhooks.png)

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

### Supaya webhook bisa dipanggil dari internet

GitHub, Stripe dan sejenisnya memanggil webhook dari internet. Kebanyakan box ada di balik router
rumah, dan panggilan itu gak pernah sampai kecuali ada yang membukakan jalan. Setiap kartu di halaman
Webhooks menyebutkan keadaannya:

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
