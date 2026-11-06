---
title: Homelab & mini PC
description: Raspberry Pi, Orange Pi, mini PC, NAS dan container LXC, apa yang jalan dan apa yang perlu diwaspadai.
---

Inilah target deployment yang menjadi dasar rancangan Nouride. Pi 4 dengan RAM 2 GB nyaman menjalankan
beberapa agent.

## Yang bekerja

| Target | Penilaian |
|---|---|
| **Raspberry Pi 4 / 5** (1 GB+) | Nyaman. `linux-arm64`. Pi 5 lebih dari cukup |
| **Orange Pi 5 / 5 Plus** | Sama. Armbian arm64 |
| **Mini PC / NUC / laptop lama** | Berlebihan, dan tetap pilihan yang tepat kalau agent mengerjakan infrastruktur |
| **VPS 512 MB apa pun** | Cukup, termasuk dashboard. Tier termurah di kebanyakan penyedia. Tanpa agent eksternal: satu agent eksternal butuh 512 MiB untuk perintah agent |
| **NAS dengan Docker** (Synology, QNAP, Unraid) | Cukup. Cek `uname -m`: beberapa arm64 |
| **LXC Proxmox** | Cukup, dengan dua catatan soal memori di bawah |
| **Alpine apa pun** | Butuh build `-musl` **dan** `apk add libstdc++` |

## Satu hal yang harus diperiksa lebih dulu

**OS kamu harus 64-bit.**

```bash
uname -m     # aarch64 → bagus.  armv7l → 32-bit, gak didukung
```

Gak ada build ARM 32-bit, dan installer berhenti alih-alih mengunduh sesuatu yang gak akan jalan.
Kalau muncul `armv7l`, pasang ulang dengan Raspberry Pi OS (64-bit), Ubuntu Server arm64, atau Armbian
arm64. Pi 3 ke atas dan semua Orange Pi modern bisa menjalankan 64-bit, image 32-bit cuma kebetulan
masih sering jadi default.

## Instalasi

Persis perintah yang sama dengan mesin Linux mana pun:

```bash
@@INSTALL_CMD@@
```

systemd mensupervisinya, ia kembali setelah reboot, dan `nouride update --start` meng-upgrade-nya di
tempat, sama seperti menjalankan ulang script-nya. Dari 0.7.x: lihat [Upgrade ke v0.8](/id/docs/deployment/upgrading-to-0-8/).

## Berapa yang benar-benar dipakainya

| | |
|---|---|
| Idle, 1 agent | ~65–75 MB resident |
| Puncak boot | kira-kira dua kali angka diamnya |
| Tiap agent tambahan | ~0,4 MB |
| CPU saat idle | 0,7% dari satu core |
| Disk | ~120 MB terpasang |

Jangan deploy di batas bawah, RAM 64 MB (diukur 2026-10-17 di linux-arm64, start pertama juga):
itu angka yang membuktikan daemon-nya kecil, bukan rekomendasi. Di batas bawah start-nya makan puluhan detik dan gak ada sisa untuk satu giliran pun.

[Setiap pengukuran, lengkap dengan asal-usulnya →](/id/docs/architecture/performance/)

## `MemoryHigh` diam-diam gak berlaku di Raspberry Pi OS

Unit systemd yang dibuat membawa plafon memori lunak di 80% dari yang dilaporkan mesin. Raspberry Pi OS
mengirimkan controller cgroup memory dalam keadaan **mati**, jadi systemd menerima pengaturannya dan
gak menegakkan apa pun:

```bash
systemctl show nouride -p MemoryCurrent --value   # `[not set]` berarti gak berlaku
cat /sys/fs/cgroup/cgroup.controllers             # gak ada `memory` di daftarnya
```

Perbaiki dengan menambahkan `cgroup_enable=memory cgroup_memory=1` ke `/boot/firmware/cmdline.txt` lalu
reboot.

## Di dalam LXC

Dua hal yang perlu diketahui.

**Persentase dihitung terhadap host.** Inilah sebabnya unit-nya menulis `MemoryHigh` sebagai angka
absolut yang dihitung saat instalasi: pada container 2 GB di node 62 GB, `80%` keluar sebagai 49,8 GB.

**`/tmp` itu RAM, dan ukurannya dihitung dari host.** Di dalam LXC, systemd menghitung ukuran `/tmp`
privat dari memori host: container 2 GB mengaku punya 32 GB kosong di sana, dan clone 1,2 GB ke situ
membuat daemon di-throttle sampai berhenti menjawab. Unit-nya memberi `/tmp` seperdelapan memori mesin,
antara 64 MB dan 1 GB, jadi penulisan yang sama gagal dengan "no space left", error yang bisa dilihat
agent dan dicarikan jalan lain.

## Daemon sering bukan yang terbesar di cgroup-nya sendiri

Layak diketahui sebelum memilih perangkat kecil. Diukur di sebuah instalasi live:

| | |
|---|---|
| daemon (dengan bridge WhatsApp in-process) | 73,3 MB |
| satu server MCP berbasis Node | 91,5 MB |

Menjalankan bridge secara in-process menghemat ~40 MB karena menghilangkan kebutuhan runtime kedua. Di perangkat 256 MB, daemon dan WhatsApp muat dengan leluasa; penambahan server MCP Node yang beratlah yang memakan memori ekstra.

CLI coding milik [agent eksternal](/id/docs/manual/external-agents/) lebih besar lagi: satu proses per agent,
dinyalakan di giliran pertamanya dan dimatikan setelah lima menit diam, terukur saat diam dengan satu sesi terbuka
324 MB untuk Claude Code dan 187 MB untuk Codex. Agent eksternal butuh 512 MiB untuk perintah agent, jadi perangkat
512 MB gak dapat.

[Varian build →](/id/docs/deployment/binaries/)

## Menjauhkan hasil kerja dari kartu SD

Keluaran agent tumbuh tanpa batas, dan kartu SD adalah bagian Raspberry Pi yang paling sering rusak.

```toml
[daemon]
workspace_dir = "/mnt/ssd/nouride-workspace"
```

Ketiga path itu kunci config terpisah justru untuk ini. Selain itu gak ada yang perlu pindah.

Yang dipasang para agent untuk diri mereka sendiri (`.nouride/bin`, `lib`, dan `opt`) serta cache di
`.nouride/home` juga ikut tumbuh. `nouride doctor` menampilkan berapa besar masing-masing.

## Apa yang ditentukan model, bukan mesin

Gak satu pun di atas bergantung pada model mana yang dipakai agent. Provider adalah endpoint jarak
jauh, jadi RAM gak terpengaruh, Raspberry Pi yang memanggil Claude dan server 64-core yang memanggil
Claude memakai memori yang sama dan menunggu selama yang sama.

Yang *memang* dipengaruhi mesin kecil adalah `exec`: build yang dijalankan agent berjalan di mesin ini.
Itulah yang sebenarnya jadi alasan rekomendasi 512 MB.
