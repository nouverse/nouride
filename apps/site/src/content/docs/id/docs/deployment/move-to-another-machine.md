---
title: Pindahkan Nouride ke Mesin Lain
description: Ekspor semua isi Nouride jadi satu file, impor di mesin baru, lalu Go live di sana.
---

Sejak 0.8.41, Nouride bisa dibawa ke mesin lain sebagai satu file: ekspor di mesin lama, pasang Nouride di mesin
baru, impor file-nya di sana, lalu **Go live**. Impor menggantikan semua isi mesin baru. Gak ada yang digabung.

## Isi file-nya

| Ada di file | Gak ada di file |
|---|---|
| Database: chat, misi, automation, akun, pemakaian, audit log | Sign-in CLI coding: masuk lagi satu per satu |
| Config dan people | Sesi milik aplikasi chat, misalnya WhatsApp yang sudah ditautkan |
| Pack agent dan skill | Snapshot (`backups/`) dan log yang disimpan sebagai file |
| Memory dan dokumen | Tool yang terpasang dan cache |
| File yang dikirim di chat, dan work notes | Folder milik agent, kecuali kamu minta |
| Secret, disegel dengan passphrase yang kamu ketik | Kunci dan control token milik mesin lama |
| | Folder kredensial (`credentials_dir`): file kunci dan file token yang dibaca agent-mu. Salin sendiri |

File-nya `.tar.gz` yang bisa kamu buka dengan `tar` biasa. Entri pertamanya, `manifest.json`, menjelaskan isi
sisanya. Yang disegel cuma secret. Sisanya bisa dibaca siapa pun yang memegang file itu, dan isinya semua chat dan
memory: simpan dengan hati-hati yang sama.

Tanpa passphrase, file-nya gak berisi secret, dan ekspor bilang begitu sebelum file dibuat. Di mesin baru, tiap
secret diisi lagi.

Folder milik agent (folder pribadi masing-masing dan folder bersama) bisa besar, jadi cuma ikut kalau diminta.
Link, folder CLI coding, file yang namanya menunjukkan isi sign-in atau kunci, dan hasil pasang tool
(`node_modules`, `.venv`) gak ikut.

## 1. Ekspor di mesin lama

Dari dashboard, sebagai admin: **Settings**, lalu **Export and import**. Halamannya bilang apa isi file dan
berapa besarnya sebelum kamu menekan **Make the file**. Ketik password untuk secret dua kali, minimal dua belas
karakter, atau hilangkan centang secret. Centang folder milik agent kalau mau ikut. Setelah file jadi, tekan
**Download**.

Dari terminal, di mesinnya langsung:

```bash
nouride export --out /var/tmp/nouride-export.tar.gz             # menanyakan passphrase, dua kali
nouride export --out /var/tmp/nouride-export.tar.gz --folders   # dengan folder milik agent
nouride export --out /var/tmp/nouride-export.tar.gz --no-secrets
```

Script memberi passphrase lewat stdin dengan `--stdin`. Perintah ini jalan baik Nouride sedang hidup atau gak, dan
gak pernah menimpa file yang sudah ada.

Di install server perintah ini jalan sebagai akun Nouride sendiri, siapa pun yang mengetiknya, termasuk root. Akun
itu gak bisa menulis di folder milik root, jadi `--out ~/…` yang diketik root ditolak: sebut folder yang bisa
ditulisinya, misalnya `/var/tmp`. File-nya hanya milik akun itu; salin keluar dari mesin sebagai root.

Biarkan mesin lama tetap jalan dulu: belum ada yang berubah di sana.

## 2. Pasang Nouride di mesin baru

Pasang seperti Nouride baru biasa ([Server & Systemd](/id/docs/deployment/production/) atau
[Docker & Compose](/id/docs/deployment/docker/)), versi yang sama dengan mesin lama atau lebih baru. File buatan
Nouride yang lebih baru dari yang mengimpornya ditolak dengan "Update Nouride first".

## 3. Impor file-nya

Dari dashboard mesin baru: masuk dengan password yang dicetak saat pemasangan, lalu di halaman pertama setup pilih
**Bring its file in**. Di instalasi yang sudah disiapkan, kartu yang sama ada di **Settings**,
**Export and import**. Pilih file-nya. Kalau berisi secret, halamannya meminta password yang kamu ketik waktu
membuatnya. Lalu ditampilkan isi file itu di samping isi Nouride ini sekarang. **Replace everything here** meminta
kata `replace` diketik, dan tombolnya menunggu sepuluh detik lagi.

Nouride lalu restart dan impornya masuk saat ia mulai. Kalau di server itu gak ada yang menyalakan Nouride lagi
dengan sendirinya, halamannya bilang begitu: restart sendiri, dan impornya masuk saat itu.

Dari terminal, dengan Nouride dihentikan:

```bash
nouride stop
nouride import /var/tmp/nouride-export.tar.gz     # menanyakan passphrase, lalu kata "replace"
nouride start                              # atau: systemctl start nouride
```

Script memberi passphrase di baris pertama stdin dan kata itu di baris kedua, dengan `--stdin`.

Di install server, taruh file-nya di tempat yang bisa dibaca akun Nouride sendiri, misalnya `/var/tmp`, dan bisa
dibaca olehnya (`chown nouride /var/tmp/nouride-export.tar.gz`): perintahnya jalan sebagai akun itu.

Yang ditolak impor, sebelum ada yang diganti: file yang bukan hasil ekspor atau terpotong, database yang rusak,
file dari Nouride yang lebih baru, passphrase yang gak membuka secret, dan kata yang gak diketik.

Isi mesin baru sebelumnya dipindah ke folder di samping datanya, `before-import-<tanggal>`, dan tetap di sana.
Kalau impor gagal di langkah mana pun, semuanya dipindah balik dan mesinnya seperti semula. Hapus folder itu
sendiri kalau kamu sudah yakin.

Mesin baru tetap memakai tempatnya sendiri: letak foldernya, serta alamat dan port dashboard-nya. Secret disimpan
dengan kunci milik mesin baru.

## 4. Masuk lagi, dan lihat apa yang ikut

Semua sesi dan token perangkat berakhir saat impor. Masuk dengan akun dari mesin lama.

**Settings**, **Export and import** sekarang dibuka dengan hasil impornya: apa yang ikut, apa yang gak, dan tempat
yang disebut config tapi gak ada di mesin ini (misalnya folder proyek sebuah agent). Masukkan lagi tiap CLI coding
dari halaman agent-nya.

Folder kredensial gak pernah ada di file itu, di mana pun config-mu menaruhnya, termasuk di dalam folder agents:
kunci ssh atau file service account di sana akan terbaca oleh siapa pun yang memegang file-nya. Salin sendiri ke
tempat yang sama di mesin baru, lewat jalur yang kamu percaya, dan jadikan milik akun layanan (`chown -R nouride`).

## 5. Matikan mesin lama, lalu Go live

Sebelum kamu menekan **Go live**, mesin baru gak membuat koneksi ke aplikasi chat dan gak menjalankan automation,
baik oleh jadwal, dijalankan manual, atau lewat webhook. Token bot yang dipakai dari dua mesin sekaligus membuat
keduanya meminta pesan yang sama, dan automation akan jalan di keduanya. Misi yang sedang jalan saat file dibuat
dijeda: lanjutkan dari **Work**.

Hentikan Nouride di mesin lama. Lalu tekan **Go live** di mesin baru. Automation-nya jalan sejak saat itu, dan ia
restart untuk menyalakan koneksinya. Kalau gak bisa restart sendiri, restart sendiri.

## Yang belum dicoba

Pemindahan ini sudah dijalankan antar instalasi dengan versi yang sama. File lama yang dibawa ke Nouride yang
lebih baru dimigrasikan seperti saat update, oleh kode yang sama, dan belum dijalankan pada instalasi lama yang
sungguhan. Instalasi yang agent-nya jalan sebagai user Linux masing-masing belum pernah dipindahkan: di mesin
baru, file di folder agent tiba sebagai milik user Nouride sendiri.
