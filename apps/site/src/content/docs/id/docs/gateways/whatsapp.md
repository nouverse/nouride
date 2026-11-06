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
# session_dir = "..."                 # opsional; kosong menyimpan login di <data_dir>/whatsapp
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

### Satu transport, satu nomor

Bridge dihosting di dalam daemon, dan setiap rilis membawanya. Gak ada executable kedua yang perlu
dipasang dan gak ada apa pun di samping daemon yang perlu dijaga tetap jalan, jadi gak ada
`bridge_transport` yang perlu diisi. Bridge menyimpan state koneksinya di module scope, jadi satu
daemon menghosting satu koneksi WhatsApp; nomor kedua butuh daemon kedua. `bridge_transport = "ws"`,
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
