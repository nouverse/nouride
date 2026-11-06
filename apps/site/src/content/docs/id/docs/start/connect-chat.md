---
title: Menyambungkan aplikasi chat
description: Memberi sebuah agent bot-nya sendiri di Telegram, Discord atau WhatsApp.
---

Gak ada yang sampai ke agent kecuali sebuah gateway mengantarkannya. Daemon baru tanpa bot token
cuma bisa dijangkau dari dashboard dan `nouride chat`: itu disengaja, dan sudah cukup untuk mulai.

Kalau sudah siap menghubunginya dari HP, tambahkan sebuah **koneksi**.

## Satu bot per agent, bukan satu bot untuk semua

Setiap koneksi punya nama: `telegram:nouva` adalah koneksi Telegram bernama `nouva`. Nama itulah yang
bikin satu daemon bisa menjalankan identitas terpisah per agent, bukan satu bot yang gonta-ganti
kepribadian.

Sebuah koneksi bisa menyebut agent sebagai pemiliknya, dan setelah itu semua yang diterimanya masuk ke
agent tersebut, kecuali ada yang lain yang dipanggil namanya.

## Lewat dashboard

Ini jalur yang lebih singkat, dan yang gak mengharuskan kamu menyentuh file.

1. **Agents → agent kamu → Connections.**
2. **Add Connection**, pilih platform, tempel token-nya.
3. Simpan, lalu **restart**: halamannya menyediakan tombol **Restart Runtime**.

Restart itu gak opsional dan dashboard bilang begitu: adapter gateway dibangun saat boot, jadi
koneksi yang tersimpan belum berarti koneksi yang berjalan. Halaman itu menampilkan "not started",
bukan "disconnected", untuk koneksi yang belum pernah naik, karena keduanya masalah yang berbeda.

![Koneksi yang tersimpan tapi belum berjalan, dengan banner Restart Runtime di atasnya](/media/gateway-restart.png)

Kredensial di sini bersifat **tulis saja**. Kolom token pada koneksi yang sudah ada selalu kosong
(placeholder-nya cuma bilang *unchanged*), dan kosong berarti *biarkan apa adanya*: gak ada yang
membaca kredensial kembali, jadi gak ada nilai tersimpan di kolom itu yang bisa gak sengaja tertimpa.

![Tab Connections milik sebuah agent](/media/dashboard-agent-connections.png)

## Lewat file konfigurasi

Hal yang sama, di `.nouride/config.toml`. Simpan token-nya dulu, file config cuma memuat *nama*
sebuah secret:

```bash
# Di-pipe, bukan diketik sebagai argumen, supaya gak pernah masuk riwayat shell.
printf '%s' '123456:ABC-DEF...' | nouride secret set telegram-nouva --stdin
```

```toml
[gateways.telegram.nouva]
enabled = true
token = "telegram-nouva"     # NAMA secret → $TELEGRAM_NOUVA, atau secret store
agent = "nouva"              # bot ini milik Nouva
```

Lalu restart daemon-nya.

---

## Telegram

1. Ngobrol dengan [`@BotFather`](https://t.me/BotFather), `/newbot`, salin token-nya.
2. Simpan dan tambahkan koneksinya seperti di atas.
3. Kirim pesan ke bot itu.

**Di grup, bot dengan privacy mode menyala nyaris gak dapat apa-apa.** Kecuali ia admin, Telegram
cuma mengirim perintah dan balasan ke pesannya sendiri, bahkan pesan yang men-tag-nya pun gak.
Pilih `/setprivacy → Disable` di BotFather (lalu keluarkan bot dari grup dan tambahkan lagi), atau
jadikan bot itu admin grup.

Approval datang di chat sebagai pesan yang kamu jawab dengan `/approve` atau `/deny`. Lihat
[approval](/id/docs/manual/approvals/).

![Menambahkan koneksi Telegram di dashboard](/media/gateway-telegram.png)

[Halaman Telegram lengkap →](/id/docs/gateways/telegram/)

---

## Discord

1. Buat aplikasi dan bot di [portal developer Discord](https://discord.com/developers/applications).
2. **Aktifkan Message Content intent** di tab Bot. Tanpa itu setiap pesan tiba kosong, yang kelihatan
   seperti bot mengabaikan kamu.
3. Undang bot ke server kamu, lalu simpan token dan tambahkan koneksinya.

```toml
[gateways.discord.main]
enabled = true
token = "discord-main"
agent = "nouva"
```

Channel mana yang dijawab sebuah agent diatur di **agent**, bukan di koneksi, lihat
[halaman Discord](/id/docs/gateways/discord/) untuk alasannya, dan untuk pengaturan cache yang penting
kalau kamu menjalankan beberapa bot Discord di satu daemon.

---

## WhatsApp

WhatsApp gak punya bot token. Kamu menautkan perangkat dengan memindai QR dari HP yang memegang
nomor itu, sekali saja.

```toml
[gateways.whatsapp.main]
enabled = true
encryption_key = "wa-encryption-key"   # NAMA secret; nilainya 64 karakter heksadesimal
agent = "nouva"
```

Dashboard membuatkan key ini untuk kamu kalau kolomnya dibiarkan kosong. Lewat file config, buat
key-nya dan simpan sebelum start:

```bash
openssl rand -hex 32 | nouride secret set wa-encryption-key --stdin
```

Yang kembali dari pemindaian adalah **login**, bukan token, jadi disimpan terenkripsi AES-256-GCM
dengan key tersebut. Salinan direktori sesi tanpa key itu gak berguna; salinan *dengan* key itu
adalah login yang berfungsi. Simpan key-nya, atau restart berikutnya minta scan ulang.

Lalu jalankan daemon dan buka dashboard, QR-nya muncul di Connections milik agent tersebut.

![QR WhatsApp di dashboard](/media/gateway-whatsapp-qr.png)

Bridge WhatsApp **dikompilasi ke dalam daemon**. Gak ada executable kedua dan gak ada yang perlu
dipasang tambahan.

[Halaman WhatsApp lengkap →](/id/docs/gateways/whatsapp/)

---

## Belum ada yang boleh bicara

Secara default, orang asing yang mengirim pesan ke salah satu bot kamu menerima kode pairing dan
menunggu, mereka gak bisa menjangkau agent sampai kamu menyetujuinya. Termasuk kamu sendiri: kirim
pesan ke bot kamu sekali, lalu setujui kode kamu sendiri.

```bash
nouride access                  # siapa yang menunggu, dan siapa yang sudah masuk
nouride access approve <kode>
```

Atau dari **Access** di dashboard, tempat permintaan semua agent menunggu. Ini antrean yang berbeda dari approval tool, dan
mencampurkan keduanya pernah menghabiskan waktu satu jam: *approval* adalah agent yang berhenti di
tengah giliran karena ingin menjalankan sesuatu; *access* adalah orang yang minta izin masuk sama
sekali.

[Siapa yang boleh bicara →](/id/docs/manual/access/)
