---
title: Cron & webhook
description: Scheduler dari baris perintah, membuat job, membaca riwayatnya, dan pagar pengamannya.
---

Sisi konseptualnya ada di [panduan pemakaian](/id/docs/manual/schedule/). Halaman ini perintahnya.

## Melihat daftar

```bash
nouride cron                     # yang terjadwal dan aktif
nouride cron --all               # termasuk yang dinonaktifkan
nouride cron runs <id>           # riwayat job ini
```

## Membuat

```bash
nouride cron add --name <nama> \
  (--at 2h | --every 15m | --cron "0 9 * * *") \
  --gateway <id> --chat <id> --agent <id> \
  [--message <prompt> | --text <pesan> | --command <shell> | --mission <goal>] \
  [--then agent] [--session fresh|isolated|chat] [--tz <zona>] [--quiet] [--keep]
```

| | |
|---|---|
| `--at 2h` / `--at "2026-11-02 09:00"` | sekali, setelah durasi tertentu atau pada jam tertentu |
| `--every 15m` | interval: `30s`, `15m`, `6h`, `1d` |
| `--cron "0 9 * * *"` | ekspresi crontab |
| `--tz <zona>` | jam mana yang dipakai membaca ekspresi `--cron` atau waktu `--at`. Default ke `[daemon] timezone` |
| `--gateway <id> --chat <id>` | ke mana hasilnya dikirim |
| `--agent <id>` | agent yang menjalankannya |
| `--message <prompt>` | bangunkan agent dengan ini. Satu giliran, dengan tool |
| `--text <pesan>` | teks biasa, tanpa panggilan model, tanpa biaya |
| `--command <shell>` | jalankan satu baris shell, tanpa panggilan model |
| `--then agent` | …lalu bangunkan agent dengan apa yang dicetaknya. Run yang tidak mencetak apa pun tidak membangunkan siapa pun dan tidak mengirim apa pun |
| `--mission <goal>` | jalankan setiap kali sebagai mission; `--check <perintah>` untuk satu cek, `--no-review` tanpa reviewer |
| `--session` | `fresh` (default, tanpa riwayat), `isolated` (thread-nya sendiri), `chat` (percakapan chat tujuan) |
| `--quiet` | catat run-nya, gak mengirim apa pun, bahkan peringatan gagal |
| `--keep` | simpan job sekali-jalan setelah menyala: dimatikan, dan tercatat sebagai `fired` |

Dari terminal, `--gateway`, `--chat` dan `--agent` wajib diisi. Agent yang menjalankan ini lewat tool
`nouride` boleh melewatkannya: default-nya percakapan tempat dia berada. Kalau `--message`, `--text`
maupun `--command` gak ada satu pun, job-nya mengirim namanya sendiri.

`--command` dijalankan lewat `sh -lc`, karena operator yang mengetiknya bermaksud satu baris shell,
bukan argv. Dari agent, job `--command` selalu minta izin dulu: ia jalan belakangan tanpa model dan
tanpa gerbang.

### Contoh

```bash
# Sebuah pengingat. Gratis: gak ada model yang dipanggil.
nouride cron add --name standup --cron "0 9 * * 1-5" --tz Asia/Jakarta \
  --gateway telegram:nouva --chat 123456789 --agent nouva \
  --text "Standup 15 menit lagi."

# Sebuah pemeriksaan dengan penilaian di atasnya.
nouride cron add --name disk --every 6h \
  --gateway telegram:nouva --chat 123456789 --agent nox \
  --command "df -h /" --then agent

# Job yang mengingat run-nya sendiri, dan gak lebih.
nouride cron add --name inbox --cron "0 8 * * *" \
  --gateway telegram:nouva --chat 123456789 --agent nouva \
  --session isolated \
  --message "Cek apa yang masuk semalam lalu beri tahu apa yang butuh saya."
```

## Mengubah dan menjalankan

```bash
nouride cron update <id> [--name …] [--at|--every|--cron …] [--tz <zona>] [--text|--message …] [--agent <id>]
nouride cron run <id>            # jalankan sekarang, dan cetak hasilnya
nouride cron enable <id>         # sekaligus membersihkan job yang mati karena deret kegagalan
nouride cron disable <id>
nouride cron rm <id>
```

`update` hanya mengirim field yang kamu sebut, jadi jadwal baru gak mengubah nama dan pesannya.

## Webhook

Endpoint yang menjalankan sebuah job ketika ada yang memanggilnya.

```bash
nouride webhook                  # apa yang ada, beserta URL-nya
nouride webhook add --name <nama> --agent <id> --gateway <id> --chat <id> \
  [--message <prompt> | --text <pesan>] [--session fresh|isolated|chat] [--quiet]
nouride webhook rotate <id>      # terbitkan URL baru; yang lama berhenti bekerja
nouride webhook test <id>        # apakah panggilan dari internet sampai; job-nya gak dijalankan
```

`POST` ke URL-nya menjalankan job; tambahkan `?wait=1` supaya hasilnya dikembalikan, bukan `202`.
Selama panggilan sebelumnya masih berjalan, panggilan berikutnya dijawab `409` dan gak dijalankan.
Body request-nya sampai ke agent setelah `--message`, ditandai sebagai data yang gak dipercaya, jadi
tulis di pesannya apa yang harus dilakukan dengan isinya. Di belakang proxy atau port map container,
isi `[dashboard] public_url`, atau URL yang tercetak adalah alamat daemon sendiri dan gak bisa
dijangkau siapa pun dari luar.

Pakai `nouride cron` untuk `rm`, `enable`, `disable`, `run` dan `runs`: job-nya sama.

**Gak ada `--command` untuk webhook.** Webhook bisa dijangkau apa pun yang mengetahui URL-nya, dan
endpoint yang menjalankan argv di host adalah remote shell dengan password panjang.

## Pagar pengaman

```toml
[cron]
enabled = true
min_interval_ms = 60000        # batas bawah jadwal berulang
max_jobs = 100                 # untuk semua agent
fail_streak_limit = 10         # kegagalan berturut-turut sebelum job menonaktifkan dirinya
catchup_window_ms = 3600000    # seberapa terlambat job masih boleh menyala
run_retention_days = 3
command_timeout_ms = 600000
unattended_approval = "auto"   # auto | deny
```

`min_interval_ms` bukan penjaga performa. Ia bedanya antara agent yang menjadwalkan sebuah pemeriksaan
dan agent yang menjadwalkan loop panggilan provider.

`catchup_window_ms` adalah sebabnya daemon yang mati tiga hari gak kembali dengan tiga hari
pengingat: di luar jendela itu, job berulang pindah ke jadwal berikutnya dan job sekali-jalan dicatat
terlewat.

`unattended_approval` menentukan apa yang terjadi ketika giliran terjadwal butuh approval yang gak
ada yang bisa memberikannya. [Approval →](/id/docs/manual/approvals/#ketika-gak-ada-yang-mengawasi)

## Background job bukan job terjadwal

`nouride jobs` mendaftar pekerjaan yang dimulai agent *saat* sebuah giliran, build panjang, script
lambat.

```bash
nouride jobs
nouride jobs log <id>
nouride jobs kill <id>
```

`kill` menghentikan job beserta semua yang dijalankannya: SIGTERM ke process group-nya, lalu SIGKILL
setelah lima detik, jadi dev server yang dijalankan lewat `sh -c` ikut berhenti bersama shell-nya, bukan
terus hidup.

Ketika salah satunya selesai, ia membangunkan agent yang memulainya, dan `[agents] job_wake_max_chain`
membatasi berapa kali itu bisa terjadi tanpa manusia di antaranya. Job yang gak mencetak apa-apa
selama `[jobs] quiet_after_minutes` (5) membangunkan agent-nya untuk memberi tahu chat bahwa job itu
masih jalan, lalu lagi di menit ke-10, 20, 40 dan seterusnya. Gak ada yang dihentikan karena diam.
`[security] job_max_ms`, mati secara default, menghentikan job yang masih jalan setelah selama itu,
seperti `kill`, dan memberi tahu agent-nya bahwa job itu gak selesai; service dikecualikan.
