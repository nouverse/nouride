---
title: WhatsApp
description: Menautkan nomor, transport bridge, dan kegagalan pengiriman yang kelihatan seperti bug.
---

WhatsApp bekerja lewat protokol multi-device, **di dalam daemon, di setiap edisi**. Ia gak punya
bot token, kamu menautkan perangkat dengan memindai QR dari HP yang memegang nomor itu, sekali saja.
Gak ada proses eksternal yang perlu dijalankan.

## Menyiapkannya

```bash
# Sesinya adalah sebuah login, jadi dienkripsi saat disimpan. Buat key-nya dulu.
openssl rand -hex 32 | nouride secret set wa-encryption-key --stdin
```

```toml
[gateways.whatsapp.main]
enabled = true
encryption_key = "wa-encryption-key"   # NAMA secret; nilainya 64 karakter heksadesimal
agent = "nouva"
# session_dir = "..."                 # opsional; kosong menyimpan login di <data_dir>/whatsapp-main
```

Lewat dashboard gak ada key yang perlu dibuat: biarkan kolomnya kosong dan dashboard membuatkannya.

Jalankan daemon dan buka dashboard, QR-nya muncul di **Connections** milik agent itu. Pindai dari HP:
WhatsApp → Perangkat Tertaut → Tautkan Perangkat.

![QR WhatsApp di dashboard](/media/gateway-whatsapp-qr.png)

:::caution[Simpan encryption key-nya]
Yang kembali dari pemindaian adalah **login**, bukan token. Salinan `session_dir` tanpa key itu gak
berguna; salinan *dengan* key itu adalah login yang berfungsi. Kehilangan key berarti restart
berikutnya minta scan ulang.
:::

## Satu nomor untuk tiap agent

Satu nomor milik satu agent, seperti bot Telegram: pesan ke nomor itu masuk ke agent itu, dan orang
diizinkan masuk untuk nomor itu saja, bukan nomor lain. Untuk memberi agent kedua nomornya sendiri,
tambahkan koneksi kedua dengan namanya sendiri, dari halaman **Connections** agent itu atau dari
terminal. Satu agent punya satu nomor: nomor kedua untuk agent yang sudah punya ditolak, dengan menyebut
nomor yang sudah ada.

```bash
nouride gateway add --platform whatsapp --name shop --agent nora
nouride restart --then "confirm whatsapp:shop connected"
```

```toml
[gateways.whatsapp.main]
enabled = true
encryption_key = "whatsapp-main-key"
agent = "nouva"

[gateways.whatsapp.shop]
enabled = true
encryption_key = "whatsapp-shop-key"   # key-nya sendiri, dibuatkan saat ditambah dari dashboard atau perintah di atas
agent = "nora"
```

Setelah restart, kode nomor baru itu ada di halaman Connections agent-nya. Pindai dari HP yang
memegang nomor *itu*. Nomor pertama gak diminta scan ulang, dan tiap kartu bilang nomornya sudah
tertaut atau masih menunggu.

Masalah satu nomor urusannya sendiri. Nomor yang ter-logout dari HP-nya, atau putus dari jaringan,
berhenti atau nyambung lagi sendirian; `/health`, `nouride status`, dan dashboard menyebut namanya,
dan nomor yang lain tetap menjawab. Nouride gak membatasi berapa nomor yang dipegang satu instalasi:
tiap nomor adalah satu koneksi lagi yang dijaga tetap terbuka ke WhatsApp.

Nomor yang ter-logout dari HP-nya bilang begitu di kartunya, di **Connections** milik agent-nya,
dengan tombol **Link again**: login lamanya dihapus dan kode baru muncul di situ, buat di-scan dari HP
yang memegang nomor itu. Nouride gak melakukannya sendiri, karena satu sinyal logout dari WhatsApp gak
dianggap sebagai akhir sebuah tautan.

Di grup yang dimasuki dua nomor kamu, pesan yang men-tag satu nomor dijawab agent pemilik nomor itu;
pesan yang gak men-tag siapa pun dijawab sekali, oleh agent yang memegang instalasi, bukan oleh tiap
nomor.

:::caution[Risiko sebuah nomor]
Nouride tersambung ke WhatsApp secara tidak resmi, seperti WhatsApp Web (lewat Baileys, library
open-source), bukan lewat Business API resmi WhatsApp. WhatsApp bisa membatasi atau mem-ban nomor yang
dilihatnya bertingkah seperti bot: menjawab banyak orang yang gak dikenalnya, mengirim banyak pesan, atau
membalas siaran. Ban gak bisa dibatalkan dari Nouride, dan chat di nomor itu bisa hilang. Pakai nomor
yang kamu rela kehilangan, bukan nomor pribadimu, dan lihat
[error 463](#error-463-kegagalan-yang-kelihatan-seperti-bug) untuk seperti apa pembatasan itu.

Agent yang [terbuka untuk semua orang](/id/docs/manual/access/#agent-yang-terbuka-untuk-semua-orang)
menjawab siapa pun yang menulis ke nomornya: cara paling berisiko memakai sebuah nomor. Mulai dengan
batas harian yang rendah. Dashboard mengatakan semua ini saat kamu menambah nomor, saat membuka agent yang
punya nomor, dan di halaman Access serta nomor milik agent yang terbuka.
:::

## Bridge-nya

```
┌──────────────────────────┐                    ┌─────────────────────────────┐
│      Daemon Nouride      │   JSON per baris   │        wa-bridge            │
│  agent · tool · antrean  │◄──────────────────►│  Baileys · QR · auth state  │
└──────────────────────────┘                    └─────────────────────────────┘
```

Engine gak pernah bicara langsung dengan Baileys, library WhatsApp-nya. Ia bicara dengan bridge lewat
protokol JSON per baris, lewat memori, karena bridge jalan di dalam daemon. Itu
menjaga masalah WhatsApp tetap jadi masalah WhatsApp, dan protokolnya cukup kecil untuk dibaca sekali
duduk.

### Satu transport, satu bridge untuk tiap nomor

Bridge dihosting di dalam daemon, dan setiap rilis membawanya. Gak ada executable kedua yang perlu
dipasang dan gak ada apa pun di samping daemon yang perlu dijaga tetap jalan, jadi gak ada
`bridge_transport` yang perlu diisi. Daemon membuka satu bridge untuk tiap koneksi WhatsApp di config:
masing-masing punya socket, login, dan reconnect sendiri, jadi satu nomor yang ter-logout atau putus
berhenti atau nyambung lagi sendirian. Sampai 0.8.48 satu daemon cuma memegang satu nomor WhatsApp, dan
nomor kedua butuh daemon kedua.

**Tiap nomor menyimpan login di foldernya sendiri**: `<data_dir>/whatsapp-<nama>` untuk koneksi bernama
`<nama>`, kecuali tabelnya menyebut `session_dir`. Dua koneksi di satu folder ditolak saat start,
dengan kedua namanya. Instalasi yang ditautkan sebelum 0.8.48 menyimpan loginnya di
`<data_dir>/whatsapp`: start pertama menulis folder itu ke tabel koneksinya sebagai `session_dir`, gak
ada yang dipindah, dan gak perlu scan ulang. `nouride config check` mengatakannya sebelum start
melakukannya.

`bridge_transport = "ws"`,
yang menjangkau bridge di tempat lain, dihapus di 0.7.10 (gak pernah ada yang melayaninya), dan
config yang menyebutnya ditolak saat start. Sejak 0.8.0 begitu juga `bridge_transport = "stdio"` beserta
`bridge_command`-nya, yang menjalankan bridge sebagai executable kedua.

[Varian dan biayanya masing-masing →](/id/docs/deployment/binaries/)

## Error 463, kegagalan yang kelihatan seperti bug

```
error 463: account restricted or missing tctoken for contact
```

WhatsApp menolak mengantarkan, karena nomor itu dibatasi dari *memulai chat baru*. Chat yang sudah ada
sudah membawa privacy token dan tetap jalan, itu sebabnya ini kelihatan pilih-pilih.

**Indikator mengetik tetap muncul**, karena presence gak dibatasi, cuma pengiriman ke chat baru yang
dibatasi. Kombinasi itu bukan bug.

Sebuah nomor kena status ini karena kelihatan seperti spam: baru dibuat, ditautkan dan dilepas
berulang kali sepanjang satu sore pengujian, lalu mengirim balasan otomatis ke orang yang belum
menyimpan nomornya.

**Yang mungkin mencabutnya**

1. Simpan nomor bot sebagai kontak di HP satunya, lalu kirim pesan ke sana. Jadi kontak biasanya
   membuat privacy token diterbitkan.
2. Tunggu. Pembatasannya sering sementara.
3. Pakai nomor yang memang sudah lama dipakai manusia, bukan yang baru.

**Yang gak boleh terjadi: mencoba ulang.** Setiap percobaan dihitung sebagai satu upaya menjangkau
lagi dan memperburuk pembatasannya. Daemon tahu ini, penolakan terminal menutup chat itu supaya pesan
berikutnya gak mengulanginya, dan penutupan itu dibuka lagi saat penautan ulang, satu-satunya momen
sebuah pembatasan mungkin sudah dicabut.

Ia juga gak senyap. Penolakannya dicatat pada level error dengan kata-kata yang bisa ditindaklanjuti
operator, dan **di-alert lewat kanal yang menurut definisinya bukan kanal yang gagal**, jadi set
`[alerts]`.

## Grup

**Mention menandai nomor, bukan nama.** Adapter membandingkan id yang di-tag dengan kedua alamat milik
koneksi itu, JID telepon dan LID, dinormalkan lintas sufiks perangkat.

**Konteks kutipan ikut serta.** Teks pesan yang dibalas dibawa dengan awalan `>`, karena
"@bot ini aman?" gak berarti apa-apa tanpa pesan yang ditunjuknya.

**Pengirim di grup adalah partisipannya.** Di DM, chat-nya *adalah* pengirimnya; menyatukan keduanya
bakal memberi setiap anggota grup satu identitas yang sama.

## Satu orang, dua id

Manusia yang sama muncul dengan dua alamat, `…@s.whatsapp.net` dan `…@lid`. Cantumkan keduanya di satu
orang (People, atau berkasnya `people/sam.toml`), atau agent mengenalnya di satu alamat dan gak di alamat lain:

```toml
[person]
name = "Sam"
ids  = ["whatsapp:15550001111@s.whatsapp.net", "whatsapp:100000000000002@lid"]
```

`whatsapp:<id>` cocok di koneksi WhatsApp kamu yang mana pun; `whatsapp:main:<id>` cuma di koneksi itu.

## Tanda dibaca

Dikirim **setelah** engine menerima sebuah pesan, gak pernah saat tiba. Dalam mode `pair`, pesan
pengirim tak dikenal dibuang, dan tanda dibaca di atasnya bakal memberi tahu mereka bahwa mereka
dilihat oleh sesuatu yang justru sedang mengabaikannya.

## Ketika ia diam

```bash
nouride logs -f | grep -E "whatsapp|bridge"
```

| Baris | Artinya |
|---|---|
| `whatsapp linked` | sudah masuk; jid-nya memuat nomor perangkat |
| `sending to the bridge` | engine menyerahkan sebuah balasan |
| `sent {...}` | Baileys menerimanya, **bukan** berarti terkirim |
| `delivery refused` | server menolaknya. Baca kodenya |
| `whatsapp pairing code ready` berulang setelah menautkan | sesinya gak tersimpan, cek encryption key dan `session_dir` |
| `unparseable line from the bridge` | ada sesuatu selain JSON protokol yang masuk ke kanal antara bridge dan adapter |

`sent` dan `delivery refused` adalah baris milik bridge sendiri dan langsung ke stderr daemon, jadi
cari di `journalctl -u nouride` atau `docker logs` kalau `nouride logs` gak menampilkannya.
`NOURIDE_WA_LOG_LEVEL=debug` menaikkan log Baileys sendiri, di stderr.

## Gak ada build tanpa WhatsApp

Setiap edisi membawa bridge-nya di dalam daemon, jadi `config.toml` yang menyebut WhatsApp selalu
punya sesuatu untuk menyambung.
