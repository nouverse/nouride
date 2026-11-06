---
title: Discord
description: Intent yang harus kamu aktifkan, channel binding, dan pengaturan cache yang memakan 20 MB.
---

Discord tersambung lewat Gateway WebSocket.

## Menyiapkannya

1. Buat aplikasi dan bot di [portal developer Discord](https://discord.com/developers/applications).
2. **Aktifkan Message Content intent** di tab Bot.
3. Undang bot ke server kamu dengan izin membaca dan mengirim pesan.
4. Simpan token dan tambahkan koneksinya:

   ```bash
   printf '%s' 'MTIz...' | nouride secret set discord-main --stdin
   ```

   ```toml
   [gateways.discord.main]
   enabled = true
   token = "discord-main"
   agent = "nouva"
   ```

5. Restart daemon.

:::caution[Tanpa Message Content intent, setiap pesan tiba kosong]
Yang kelihatan persis seperti bot mengabaikan kamu. Ini hal pertama yang harus dicek.
:::

## Channel mana yang dijawab sebuah agent

Diatur di **agent**, bukan di koneksi, karena koneksi adalah identitas dan binding adalah cakupan,
dan satu agent bisa menjawab di beberapa koneksi:

```toml
# .nouride/agents/nouva/config.toml
[channels]
"discord:main" = ["123456789012345678"]   # ID channel-nya; thread punya ID sendiri
```

Nyalakan Developer Mode di Discord, lalu klik kanan sebuah channel → **Copy Channel ID**.

Kosong atau gak ada berarti agent menjawab saat dipanggil namanya, atau selalu, kalau koneksinya
menyebutnya sebagai pemilik lewat `agent = "..."`.

## Slash command

Setiap kali tersambung, daemon mendaftarkan perintahnya (`/status`, `/approve`, `/new`, …) sebagai
slash command Discord milik bot itu sendiri, jadi muncul di picker dengan namanya. Discord bisa butuh
sampai satu jam untuk menampilkan perubahan. Mengetik perintahnya sebagai pesan, `@bot /status`, juga
jalan.

## Pengaturan cache, dan kenapa default-nya nol

```toml
[gateways.discord.main.cache]
messages = 0   # per channel
users    = 0   # global
members  = 0   # per guild
```

discord.js mengirimkannya tanpa batas, kecuali 200 pesan per channel, dengan sweeper yang cuma
menyapu thread. Dengan satu bot per agent, itu berarti satu set cache *per koneksi*: diukur di sebuah
mesin live, enam di antaranya menumbuhkan daemon dari 76 MB ke 97 MB dalam dua puluh menit.

Gak ada di adapter yang membacanya. Penulis pesan dan anggota tiba di payload gateway, dan mengambil
sebuah pesan tetap panggilan REST, jadi biayanya gak membeli apa pun.

Naikkan salah satunya cuma kalau ada yang mulai membutuhkannya. Channel dan guild selalu di-cache dan
gak bisa diatur: keduanya dibatasi oleh berapa banyak tempat bot itu ditambahkan, bukan oleh trafik.

## Beberapa bot Discord dalam satu channel

Inilah susunan yang jadi tujuan desain multi-agent, dan di sinilah perilaku menariknya berada, Discord
menyebarkan setiap pesan channel ke setiap bot di channel itu, jadi enam bot berarti enam salinan satu
pesan.

Versi singkatnya: di channel dengan lebih dari satu bot kamu, **sebuah pesan harus menyebut tujuan**,
dan tag yang menyebut orang lain menuju ke gak ada, bukan jatuh ke fallback.

[Gambaran lengkapnya →](/id/docs/gateways/overview/#beberapa-bot-dalam-satu-channel)

Dua konsekuensi praktis:

**Sebuah bot cuma bisa bicara di tempat ia diundang.** Setiap agent menjawab lewat koneksinya
*sendiri*, dan gak ada di config yang menyatakan channel mana yang dimasuki sebuah bot. Baris log
`an agent's own connection could not deliver here` berarti: undang bot itu ke channel tersebut.

**Tag sebelum perintah slash dibuang.** Discord mengirim `<@self> /approve`, dan baik parser perintah
maupun pemeriksa urgensi antrean cuma mengenali teks yang diawali `/`: jadi perintah yang di-tag
bukan perintah dan bukan mendesak, lalu mengantre di belakang giliran yang justru sedang menunggu
disetujui. Adapter membuang tag dirinya sendiri di awal teks.

## Mention

Engine gak pernah memformat mention sendiri, sintaksnya milik platform. Setiap agent diberi token
persis yang harus diketik untuk tiap agent lain, diambil dari koneksi milik agent itu, yang di Discord
berbentuk `<@id>`.

Nama *aplikasi* Discord sebuah bot bukan id agent-nya. `@Nero | Infra Agent` adalah yang tertulis di
portal; `nero` adalah agent-nya. Keduanya dikenali.
