---
title: Chat lewat terminal
description: Ngobrol dengan agent tanpa bot token, lewat gateway in-process yang sungguhan.
---

```bash
nouride chat            # orchestrator
nouride chat nouva      # panggil satu agent lewat namanya
```

Gak ada yang sampai ke agent kecuali sebuah gateway mengantarkannya, jadi daemon baru tanpa token
Discord atau Telegram gak bisa dijangkau dari aplikasi chat. Ini dan chat di dashboard adalah jalan
masuknya.

![Sesi chat di terminal](/media/cli-chat.png)

## Ini gateway sungguhan, bukan jalan pintas

Pesan melewati gateway `local` yang in-process, jadi routing, hook, antrean, tool loop dan penyimpanan
sesi semuanya berjalan persis seperti untuk platform chat. Itulah yang menjadikannya tes end-to-end
sungguhan, bukan konsol debug.

Ia menyala secara default. `chat = false` di bawah `[control]` mematikannya.

## Yang bisa dipakai di sini

- **Perintah slash.** Semuanya, `/new`, `/model`, `/approvals`, `/drafts`.
- **File.** `/attach <path> [teks]` mengirim file, seperti yang dilakukan platform.
- **Approval di tempat.** Permintaan muncul di tengah giliran dan jawaban satu huruf menyelesaikannya:
  `y`, `a` untuk "always" (kalau permintaannya bisa diizinkan permanen), atau `N`.
- **Progres langsung.** Langkah tool saat terjadi, bukan jeda lalu dinding teks.
- **Sesi.** Percakapannya `cli-<pid>`, jadi setiap kali perintah dijalankan ia jadi thread-nya sendiri.

## Non-interaktif

Stdin yang di-pipe **dideteksi**, bukan diasumsikan:

```bash
echo "berapa pemakaian disk di mesin ini?" | nouride chat nouva
```

Approval dicetak alih-alih ditanyakan, lengkap dengan perintah `nouride approvals` untuk menjawabnya,
dan perintahnya gak mencoba membaca dari stream yang sudah berakhir. Script yang mengendalikannya
adalah pemakaian kelas satu, begitulah tes end-to-end bicara dengan daemon, dan dulu memaksa
memunculkan prompt bikin crash saat EOF.

## Ke daemon jarak jauh

Sebagian besar perintah, termasuk `chat`, bicara ke daemon yang sedang jalan lewat control API, jadi
ini juga bisa lewat jaringan:

```bash
export NOURIDE_URL=https://nouride.example.com
export NOURIDE_TOKEN=<isi data/.control-token mesin itu>
nouride chat
```

Secara lokal ia membaca `data/.control-token` sendiri, itu sebabnya gak butuh token di mesin itu.

## Kenapa ia gak menjalankan daemon-nya sendiri

CLI yang menyalakan daemon cuma untuk menjawab pertanyaan bakal melaporkan proses yang gak dipakai
siapa pun, dan `nouride chat` bakal bicara dengan salinan kedua yang punya koneksi gateway-nya sendiri.
Dua bot Telegram yang polling satu token masing-masing cuma dapat separuh pesan.

Jadi ini butuh daemon yang sedang jalan. Kalau belum ada, jalankan service-nya
(`sudo systemctl start nouride`), atau jalankan satu di foreground:

```bash
nouride start
```

## Keluar

`/quit` (atau `/exit`), atau Ctrl-D.
