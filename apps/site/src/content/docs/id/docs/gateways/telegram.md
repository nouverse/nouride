---
title: Telegram
description: Membuat bot, privacy mode di grup, dan menjawab approval dari chat.
---

Telegram tersambung lewat Bot API dengan long polling. Mode webhook belum diimplementasikan.

## Menyiapkannya

1. Ngobrol dengan [`@BotFather`](https://t.me/BotFather), kirim `/newbot`, salin token-nya.
2. Simpan, file config cuma memuat *nama* sebuah secret:

   ```bash
   printf '%s' '123456:ABC-DEF...' | nouride secret set telegram-nouva --stdin
   ```

3. Tambahkan koneksinya:

   ```toml
   [gateways.telegram.nouva]
   enabled = true
   token = "telegram-nouva"
   agent = "nouva"
   ```

4. Restart daemon, lalu kirim pesan ke bot itu.

Atau lakukan semuanya dari dashboard: **Agents → agent kamu → Connections**.

![Menambahkan koneksi Telegram di dashboard](/media/gateway-telegram.png)

## Grup: privacy mode

Secara default, **Telegram nyaris gak mengantarkan apa pun dari grup ke bot kamu.** Bukan daemon-nya,
Telegram-nya. Dengan privacy mode menyala, bot yang bukan admin cuma menerima perintah dan balasan ke
pesannya sendiri, **bukan** pesan yang men-tag `@username`-nya. Dari sisi chat, itu kelihatan persis
seperti bot sedang mati. Dua cara mengubahnya:

- BotFather → `/setprivacy` → **Disable**, lalu keluarkan bot dari setiap grup dan tambahkan lagi, atau
- jadikan bot itu admin grup.

Daemon mencatat peringatan saat connect kalau privacy mode menyala. Sampai salah satunya dilakukan,
agent cuma menjawab balasan dan perintah di grup itu, dan `group_context_messages` gak punya bahan.

Telegram juga gak pernah mengantarkan pesan satu bot ke bot lain, privacy mode atau bukan. Dua agent
di grup yang sama bisa melihat balasan satu sama lain karena daemon sendiri yang meneruskannya.

## Approval

Ketika agent berhenti untuk minta izin, permintaannya tiba di chat sebagai pesan: apa yang ingin
dijalankan, dan kenapa ia bertanya. Jawab dari keyboard:

```
/approve
/approve always
/deny
```

`/approve always` cuma ditawarkan kalau permintaannya bisa jadi izin permanen. `/approve all` menjawab
semua yang sedang menunggu di chat itu.

[Approval →](/id/docs/manual/approvals/)

## Menu perintah

Daemon mendorong daftar perintah slash-nya ke menu bawaan Telegram untuk setiap bot setiap kali
koneksinya tersambung, jadi orang yang memakainya gak perlu hafal satu pun.

```
/commands
```

Melakukan hal yang sama secara manual, kalau menunya kelihatan basi.

Daftarnya dibuat dari registry yang sama yang menjawab perintahnya, karena daftar yang diketik ulang
adalah daftar yang bakal basi.

## Reconnect

Koneksi yang putus dicoba lagi sepuluh kali, jedanya berlipat dua dari satu detik sampai satu menit, dan
selama tersambung dicek tiap tiga puluh detik. Ritme itu milik adapter-nya sendiri; sampai 0.8.0 diatur
tabel `[resilience]` di bawah gateway, dan tabel yang masih ada di `config.toml` disebut di peringatan
lalu diabaikan.

Koneksi yang menghabiskan jatah percobaannya ditandai mati dan memicu alert, kalau kamu sudah
menentukan ke mana alert dikirim. Kalau belum, ia cuma satu baris di log, dan kamu baru tahu ketika
sadar agent-nya sudah lama diam.

Pesan yang dikirim saat bot offline gak dibuang: Telegram menyimpannya, dan daemon menjawab yang masih
baru begitu tersambung lagi. [Saat daemon restart →](/id/docs/gateways/overview/#saat-daemon-restart)

```bash
nouride gateway                        # status setiap koneksi
nouride gateway restart telegram:nouva
```

## Beberapa bot Telegram

Satu koneksi per agent, masing-masing dengan token dan `@username`-nya sendiri:

```toml
[gateways.telegram.nouva]
enabled = true
token = "telegram-nouva"
agent = "nouva"

[gateways.telegram.nox]
enabled = true
token = "telegram-nox"
agent = "nox"
```

Di grup yang memuat keduanya, menyebut tujuan jadi wajib, pesan yang gak menyebut siapa pun gak
dijawab siapa pun, alih-alih dijawab keduanya.
[Kenapa, dan apa yang dihitung sebagai menyebut tujuan →](/id/docs/gateways/overview/#beberapa-bot-dalam-satu-channel)

## Membatasi siapa yang boleh memakainya

Akses diurus daemon, bukan Telegram. Secara default orang asing dapat kode pairing lalu menunggu.

```bash
nouride access
nouride access approve <kode>
```

[Siapa yang boleh bicara →](/id/docs/manual/access/)
