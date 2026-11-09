---
title: Paket sistem
description: "Mengizinkan agent memasang, menghapus, dan meng-upgrade paket sistem di instalasi yang di-sandbox: mati di host kecuali kamu memintanya, nyala di image Docker Nouride, lewat service root kecil dengan aturan tetap, dan selalu minta izin kamu."
---

Daemon jalan di dalam sandbox: user tanpa hak khusus, `NoNewPrivileges`, dan `/usr` yang read-only. Apa
pun yang dijalankannya gak bisa jadi root, termasuk lewat `sudo`. Itu memang tepat untuk daemon yang
menjalankan perintah pilihan model bahasa, dan artinya agent gak bisa memasang paket sistem seperti
`pdftotext` sendiri.

Biasanya agent memang gak perlu. Agent memasang program ke folder bin miliknya sendiri
(`.nouride/bin`), tanpa root dan tanpa flag tambahan: `npm i -g`, `bun add -g`, `pipx install`,
`uv tool install`, `go install` dan `cargo install` semuanya mendarat di sana, begitu juga binary
rilis yang dipasang dengan `install -m 755`. `pip install` masuk ke environment Python bersama
(`.nouride/opt/python`), yang tetap melihat paket Python milik sistem. Semuanya ada di `PATH` untuk
setiap perintah, bertahan setelah restart maupun update, dan `nouride doctor` menampilkan isinya.

Daemon membangun environment Python itu saat start. Di Debian dan Ubuntu, ini butuh paket
`python3-venv`; tanpa paket itu, `pip install` kena penolakan `externally-managed-environment` dari
sistem, dan `nouride doctor` menjelaskan sebabnya.

Untuk program yang gak punya versi seperti itu, kamu bisa mengizinkan agent memasang paket sistem
juga. **Fitur ini mati kecuali kamu menyalakannya.**

## Menyalakannya

```bash
curl -fsSL @@INSTALL_URL@@ | sudo sh -s -- --allow-packages
```

Kalau instalasinya gak ada di
`@@INSTALL_DIR@@`, tambahkan `--dir` dengan path-nya, karena tanpa itu installer malah bikin instalasi
kedua di sana. Di instalasi yang sudah ada, perintah ini aman dijalankan: agent, memory, dan setting
tetap. Menjalankan installer lagi nanti tanpa flag ini tetap mempertahankannya, jadi update gak pernah
mematikannya. Untuk mematikannya, pakai `--no-packages`.

Saat mati, gak ada yang menanyakannya ke kamu. Agent tahu batasnya: dia memasang ke folder bin
miliknya sendiri, dan baru bilang ke kamu, lengkap dengan perintah di atas, kalau sebuah tugas memang
butuh paket sistem.

## Apa yang bisa dilakukannya

Fitur ini memasang `nouride-pkg`, service root kecil yang memasang, menghapus, dan meng-upgrade paket
dari repositori sistem kamu sendiri, dan gak bisa apa-apa selain itu:

- **Cuma dari repositori kamu, dengan nama persis.** Gak bisa file, URL, repositori baru, atau opsi.
  Isi permintaan cuma operasi dan nama paket.
- **Paket yang membuat box tetap bisa dijangkau gak pernah dihapus**: ssh, jaringan, `sudo`, init
  system, libc, dan package manager-nya. Penghapusan yang akan ikut menyeret salah satunya sebagai
  dependensi ditolak seluruhnya.
- **Setiap perubahan disimulasikan dulu.** Apa yang akan dipasang dan dihapus ditampilkan sebelum
  apa pun terjadi.
- **Kamu menyetujui setiap perubahan.** Untuk agent, `install`, `remove`, dan `upgrade` selalu minta
  izin, gak bisa disetujui "selalu", dan gak ikut auto-approval atau tugas terjadwal. Satu-satunya
  pengecualian adalah agent dengan level approval `trusted`: gak ada yang ditanyakan untuknya, termasuk
  ini, jadi agent menyebutkan apa yang dia pasang.

Aturannya ada di service itu, dimiliki root, dan berlaku dari mana pun permintaannya datang. Agent
jalan sebagai user yang sama dengan daemon, jadi apa pun yang percaya bahwa daemon sudah bertanya dulu
juga akan percaya pada agent yang melewatinya. Kemungkinan terburuknya: paket dari repositori kamu
sendiri terpasang atau terhapus, dan gak pernah paket yang dilindungi.

## Cara pakai

```bash
nouride pkg                               # nyala atau mati, dan package manager apa
nouride pkg check install poppler-utils   # apa yang akan berubah, tanpa mengubah apa pun
nouride pkg install poppler-utils
nouride pkg remove poppler-utils
nouride pkg upgrade                       # semua yang ada update-nya; atau sebut nama paketnya
nouride pkg refresh                       # perbarui daftar paket
```

Agent memakai perintah yang sama lewat tool `nouride`. `install`, `remove`, `upgrade`, atau `refresh`
dari agent jalan sebagai background job, karena upgrade besar butuh waktu lebih lama dari empat menit
yang didapat perintah di foreground; agent dikabari begitu selesai. Service-nya menulis output package
manager ke file dan baru mengirimnya setelah perubahan beres, jadi job yang dihentikan, atau daemon
yang restart di tengah perubahan, gak pernah meninggalkan `dpkg` setengah jalan. Setiap perubahan
tercatat: `journalctl -t nouride-pkg`.

Yang didukung: `apt` (Debian, Ubuntu, Raspberry Pi OS) dan `apk` (Alpine). Di host butuh systemd; image Docker
Nouride menjalankannya sendiri (lihat di bawah).

Fitur ini gak berlaku untuk:

- **macOS**: Homebrew gak butuh root.
- **Daemon yang jalan sebagai root**, yaitu Nouride Box atau `nouride service install --privileged
  --user root`: daemon-nya menjalankan package manager sendiri, di bawah kebijakan exec seperti
  perintah lainnya.

## Di Docker

Image Nouride menyalakannya (0.8.15). Root di dalam container adalah root milik container, bukan
milik host, dan membuat ulang container mengembalikan image-nya, jadi gak ada yang perlu dipasang:
entrypoint, yang jalan sebagai root sebelum menyerahkan container ke user daemon, menjalankan
`nouride-pkg` dengan aturan yang sama, dan package manager-nya `apk` (Alpine). Paket bawaan image juga
dilindungi: menghapusnya akan merusak container sampai container dibuat ulang.

Yang dipasang agent tetap ada. Daftarnya dan paket yang sudah diunduh disimpan di volume, di
`.nouride/system-packages`, lalu dipasang lagi saat container dibuat ulang (setiap update melakukan
itu) dari paket yang sudah diunduh, dengan atau tanpa jaringan, sebelum daemon jalan.

```bash
docker exec nouride nouride pkg install ffmpeg   # atau minta ke agent: kamu yang menyetujui, kecuali agent-nya trusted
```

Untuk mematikannya, jalankan container dengan `NOURIDE_SYSTEM_PACKAGES=off` di environment-nya;
container yang dijalankan sebagai user selain root (`--user`) juga mati fiturnya. Setiap perubahan
tercatat di log container: `docker logs nouride 2>&1 | grep nouride-pkg`.

## Manual

Untuk instalasi tanpa installer, jalankan sebagai root dari tarball rilis:

```bash
install -d -m 755 /usr/local/lib/nouride-pkg/backends
install -m 755 pkg/nouride-pkg /usr/local/lib/nouride-pkg/
install -m 644 pkg/backends/*.sh /usr/local/lib/nouride-pkg/backends/
sed 's/@GROUP@/nouride/' pkg/systemd/nouride-pkg.socket > /etc/systemd/system/nouride-pkg.socket
install -m 644 'pkg/systemd/nouride-pkg@.service' /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now nouride-pkg.socket
systemctl restart nouride
```

Pastikan file-file ini dimiliki root dan berada di luar folder instalasi. Salinan yang bisa diedit
oleh user service sama saja dengan jalan menuju root.

## Distro lain

Setiap package manager adalah satu file di `pkg/backends/`, yang menjawab tujuh pertanyaan yang sama:
apakah ini package manager host ini, apa yang dilindungi, apakah repositori punya paket dengan nama
persis ini, dan apa yang akan dilakukan sebuah perubahan. Aturannya tetap di `nouride-pkg`. Di
repositori, letaknya di `packages/system-packages`: `root/` berisi semua yang jalan sebagai root, dan
`root/backends/README.md` menjelaskan cara menambah satu.
