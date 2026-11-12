---
title: Ikhtisar gateway
description: Koneksi bernama, satu identitas bot per agent, dan apa yang terjadi saat enam bot berbagi satu channel.
---

Gateway adalah adapter antara platform chat dan daemon. Setiap koneksi punya **nama**:

```toml
[gateways.<platform>.<nama>]
```

`[gateways.telegram.nouva]` adalah koneksi dengan id `telegram:nouva`. Penamaan itulah yang bikin satu
daemon bisa menjalankan satu identitas bot per agent, bukan satu bot yang gonta-ganti kepribadian.

## Empat platform

| | |
|---|---|
| **[Telegram](/id/docs/gateways/telegram/)** | Bot API, long polling. Perintah daemon muncul di menu perintah Telegram |
| **[Discord](/id/docs/gateways/discord/)** | Gateway WebSocket. Butuh Message Content intent. Perintah daemon jadi slash command native |
| **[WhatsApp](/id/docs/gateways/whatsapp/)** | Multi-device, lewat bridge yang jalan di dalam daemon |
| **[Chat terminal](/id/docs/gateways/cli-chat/)** | In-process. `nouride chat`, tanpa token |

Gak ada yang didefinisikan secara default, jadi instalasi baru cuma menyalakan dashboard, alih-alih
terus mencoba menyambung ke platform yang token-nya gak ada.

## Kepemilikan dan routing

```toml
[gateways.telegram.nouva]
enabled = true
token = "telegram-nouva"     # NAMA sebuah secret
agent = "nouva"              # bot ini milik Nouva
```

`agent` menjadikan koneksi itu bot milik agent tersebut: semua yang diterimanya masuk ke agent itu
kecuali ada yang lain yang dipanggil namanya. Tanpanya, routing jatuh ke channel binding di
`config.toml` milik agent.

Urutan routing, dari yang tertinggi:

1. **Mention**: tag platform bot ini, atau id/nama tampilan agent di dalam teks
2. **Balasan** ke pesan yang ditulis sebuah agent
3. **Pemilik gateway**: `agent = "..."`
4. **Channel binding** di pack sebuah agent
5. **Di DM, satu-satunya agent** kalau cuma satu yang jalan
6. **Orchestrator**

## Koneksi tersimpan bukan koneksi berjalan

Adapter dibangun saat boot. Menambah atau mengubah gateway, dari dashboard atau file config, butuh
restart, dan dashboard bilang begitu serta menyediakan tombolnya. Menghapus gateway langsung
menghentikannya saat itu juga.

```bash
nouride gateway                       # status koneksi
nouride gateway restart <id>
nouride gateway add --platform telegram --name nouva --agent nouva --stdin
nouride gateway rm <id>
```

Mengganti nama adalah pengecualian yang harus dilakukan dengan daemon **berhenti**, karena ia menulis
ulang semua yang menyebut gateway itu (config dan database yang sedang dibuka daemon, `[channels]` dan
`sender_allowlist` di tiap pack agen, dan vault memori):

```bash
nouride gateway rename telegram:old telegram:new --apply
```

## Saat daemon restart

Setiap pesan dicatat begitu tiba, dan setiap langkah sebuah giliran dicatat saat terjadi. Jadi update,
reboot, atau crash cuma bikin tertunda, bukan kehilangan percakapan:

- **Pesan yang dikirim saat daemon mati** dijawab begitu daemon kembali, kalau dikirim dalam 15 menit
  terakhir. Pesan yang lebih lama dapat catatan singkat bahwa pesannya masuk saat daemon offline,
  bukan jawaban telat untuk pertanyaan lama.
- **Pesan yang dikirim dua kali oleh platform** dijawab sekali.
- **Giliran yang terpotong restart** menyimpan semua yang sudah dikerjakan dan memberi tahu chat-nya
  apa yang selesai dan apa yang terpotong. Kalau daemon kembali dalam 15 menit, agent melanjutkan
  dari situ dengan sendirinya, sekali. Kalau lebih lama dari itu, gak ada yang jalan dengan
  sendirinya: bilang "continue".
- **Balasan yang ditulis tepat sebelum crash** dikirim setelah restart, kalau umurnya belum setengah
  jam.

Stop yang direncanakan (`systemctl stop`, **Restart Runtime**) meminta setiap giliran yang sedang jalan
berhenti di langkah berikutnya, menutup dengan apa yang sudah dikerjakan dan bilang begitu di
chat-nya, sebelum gateway mati. Restart atau update menunggu sampai gak ada yang berjalan: giliran
atau approval paling lama sepuluh menit, background job sampai selesai.

## Beberapa bot dalam satu channel

Inilah susunan yang memang jadi *tujuan* daemon multi-agent, dan di sinilah semua perilaku menariknya
berada. Semua di bawah ini ditemukan di Discord live dengan enam agent dalam satu channel.

Satu fakta yang jadi dasar sisanya:

> **Platform mengantarkan setiap pesan channel ke setiap bot di channel itu.** Enam bot berarti daemon
> menerima enam salinan satu pesan, di enam koneksi, dan merutekan tiap salinan secara terpisah.

Apa pun yang menyala *per koneksi* menyala enam kali. Apa pun yang gak menyebut nama agent berlaku di
keenamnya sekaligus.

### Menyebut tujuan jadi wajib

Aturan yang gak menyebut agent, "pemilik koneksi ini yang menjawab", "jatuh ke orchestrator",
benar enam kali. Keduanya pernah dirilis, dan keduanya menghasilkan enam balasan untuk pesan satu
kata.

Jadi ketika lebih dari satu koneksi aktif berbagi satu platform **dan chat-nya bukan DM**, kedua
fallback itu dimatikan dan sebuah pesan harus menyebut tujuannya:

| Sinyal | Menuju |
|---|---|
| Tag platform milik bot ini sendiri | agent milik koneksi itu |
| Id atau nama tampilan agent di teks (`nox:`, `@nox`) | agent itu |
| Balasan ke pesan yang ditulis sebuah agent | agent itu |
| Agent yang ditunjuk ruangan itu (`/mention <agent>`), untuk pesan yang gak menyapa siapa pun | agent itu |
| Channel binding di sebuah pack | agent itu |
| **Tag platform milik orang lain** | **gak ada**: inilah penjaga yang menghentikan banjir |
| Gak ada | gak ada |

DM tetap punya kedua fallback: pesan pribadi ke bot Nero jelas milik Nero, seberapa pun banyak bot lain
yang ada. Platform dengan satu koneksi aktif juga tetap punya keduanya, itu kondisi kebanyakan
instalasi, dan menahannya di sana bakal bikin bot tunggal berhenti menjawab pesan biasa.

### Orchestrator adalah meja depan

Baris "Gak ada" punya jawaban di grup yang gak mewajibkan mention: orchestrator (`[daemon] orchestrator`,
agent pertama yang kamu buat) menjawab pesan yang gak menyapa siapa pun, sekali saja, lewat bot-nya
sendiri. Bot lain diam. Agent-nya sama di setiap salinan pesan, jadi klaim satu-giliran-per-pesan di
bawah cuma meloloskan satu, dan prompt-nya menyuruhnya menjawab sendiri atau meneruskan ke agent yang
headline-nya cocok. Baris lain di tabel gak berubah, DM gak terpengaruh, dan grup yang mewajibkan
mention (`groups_require_mention`, atau `/mention required` di grup itu) tetap diam untuknya juga.

Sebuah grup bisa menyebut agent lain untuk baris itu, dari dalam grup: `/mention @NovelistBot` (admin),
dan novelis yang menjawab setiap pesan di sana yang gak men-tag siapa pun, di tempat orchestrator.
Urutannya di bawah tag, reply, dan tag ke orang lain, dan di atas pemilik koneksi, channel binding, dan
orchestrator: itu ucapan orang di ruangan itu tentang ruangan itu. `/mention required` meminta tag, dan
`/mention default` menghapus setelan milik grup. Setelannya disimpan untuk grup sebagaimana platform
mengenalnya, bukan untuk satu koneksi, jadi setiap bot di grup membaca nilai yang sama, dan perintahnya
dijawab satu bot, sekali. Topik Telegram adalah ruangan sendiri.
[Ngobrol dengan agent → Grup](/id/docs/manual/chatting/#grup)

### Satu giliran per pesan

Ketika sinyalnya sama di setiap koneksi, sebuah nama di teks, sebuah balasan, keenamnya sampai pada
kesimpulan yang sama, dan agent bakal menjawab enam kali. Sebuah klaim diambil setelah routing dan
sebelum efek samping apa pun, dikunci pada `platform : chat : messageId : agentId`.

Dikunci **pada agent sekaligus pesan** dengan sengaja: dua koneksi yang sampai pada kesimpulan
*berbeda* gak sedang berkonflik. Satu pesan yang men-tag dua bot menuju dua agent, dan keduanya memang
harus menjawab.

### Satu identitas, empat keluaran

Sebuah agent mengucapkan empat jenis hal, jawaban akhirnya, baris progres langsungnya, prompt approval,
dan indikator mengetik, dan semuanya keluar lewat koneksi *milik agent itu*, bukan koneksi tempat
pesannya masuk.

Sebelum itu benar, yang terlihat adalah permintaan approval satu agent muncul dengan nama dan avatar
agent lain, disusul bot yang salah "mengetik…" sepanjang waktu, lalu `@BotSalah /approve` mencari
permintaan yang gak pernah miliknya.

Gak ada di config yang menyatakan channel mana yang mengundang sebuah bot, jadi pengiriman masih bisa
gagal; jalur jawabannya jatuh kembali ke koneksi masuk alih-alih diam. Baris log
`an agent's own connection could not deliver here` berarti satu hal: **undang bot itu ke channel
tersebut.**

### Mention adalah sintaks platform, bukan milik kita

Prompt memberi tiap agent token persis yang harus diketik untuk tiap agent lain, diambil dari koneksi
milik agent itu. Discord memberi `<@id>`, Telegram memberi `@username`. Engine gak pernah memformat
mention sendiri.

Agent tanpa koneksinya sendiri jatuh ke `@<agentId>`, yang dipahami pencocok teks.

### Bot gak pernah ditawari kode pairing

Gerbang akses berjalan sebelum pemeriksaan bot dan sebelum routing. Kode pairing adalah sesuatu yang
dibaca dan diteruskan manusia; bot gak melakukan keduanya, dan di platform yang menyebar setiap pesan,
kode itu menjadi pengirim tak dikenal baru bagi *setiap koneksi lain*. Satu tag pernah menghasilkan dua
belas pesan.

Bot lewat gerbang dan dinilai dengan "apakah ini milik kita". Dan di grup, orang asing cuma di-pair
oleh bot yang ia sapa (di-tag, disebut namanya, atau di-reply): bot itu membalas dengan kode di bawah
pesannya, dan bot lain di grup diam serta gak membuka permintaan. Gerbangnya menyala sekali per
koneksi, jadi tanpa ini satu tag bakal disambut dinding kode.

## Alert

Daemon melaporkan tentang *dirinya sendiri* lewat gateway yang kamu tunjuk, koneksi yang menyerah
reconnect, sesi WhatsApp yang perlu ditautkan ulang:

```toml
[alerts]
gateway = "telegram:nouva"
chat_id = "123456789"
```

Tanpa itu, gateway yang mati cuma satu baris di log. Boot memperingatkan selama ini masih kosong.
