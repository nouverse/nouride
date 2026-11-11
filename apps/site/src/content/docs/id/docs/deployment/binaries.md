---
title: Varian & Unduhan
description: Pilihan varian Nouride, spesifikasi sumber daya, serta link unduhan langsung untuk instalasi mandiri.
---

Ada satu edisi publik, Community, tersedia sebagai tarball Linux dan macOS serta container image. Ia membawa
WhatsApp dan [gateway LLM Nougate](/id/docs/providers/nougate/) langsung di dalam binary.

## Edisi

| Edisi | Binary | Tarball | RSS Idle | Keterangan |
|---|---|---|---|---|
| **Community** | ~89 MB | ~40 MB | ~58 MB | Edisi self-hosted gratis. Bisa dijalankan di server Linux, VM, atau komputer lokal mana pun. |

Ukuran di atas perkiraan, diukur dari build `linux-x64` versi 0.7. Angka RSS idle diambil dari rilis
yang lebih lama dan belum diukur ulang.

Community memakai satu akun dengan password lokal, database SQLite in-process, dan konfigurasi TOML. Nougate ada
di proses yang sama dan mati sampai kamu memilih **Use Nougate** di setup atau menyalakannya dari halaman
**LLM Gateway** di dashboard (`[nougate] in_process = true`). Selama ikut tapi mati, biayanya sekitar 0,5 MB binary
dan 1,3 MB memori; saat menyala dan idle, sekitar 3,6 MB lagi. Ia bukan proses kedua.

Edisi Router, yaitu Community dengan gateway menyala, sudah menjadi bagian dari Community sejak 0.8.28: install
Community, lalu nyalakan Nougate dari dashboard. Instalasi Router dari sebelumnya pindah ke Community sendiri lewat
update-nya, dengan Nougate tetap menyala.

Pro menambahkan akun multi-user, masuk dengan Nouverse, dan pairing Nouride Box, plus gateway LLM yang
sama, mati sampai `[nougate] in_process = true`. Pro gak publik: gak ada unduhan atau image publik untuknya.

---

## Unduhan

Tarball diunduh dari `@@DOWNLOAD_DOMAIN@@`, satu per target. Isinya executable `nouride`, dashboard,
skill bawaan, `config.example.toml`, dan `pkg/`, service root yang dipasang oleh
[`--allow-packages`](/id/docs/deployment/system-packages/). Tarball Linux juga berisi `run/`, helper
`nouride-run` yang dipasang `install.sh` supaya [perintah tiap agent jalan sebagai user miliknya sendiri](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri).
Isinya juga `frontend/`, console milik gateway-nya.

### Instalasi Cepat via CLI

Cara paling ringkas untuk memasang atau memperbarui Nouride di Linux:

```bash
@@INSTALL_CMD@@
```

Installer memilih build yang cocok dengan CPU dan C library mesin ini (glibc atau musl), dan berhenti
di ARM 32-bit, yang memang gak punya build.

### Unduh Binary Langsung

Kamu juga bisa mengunduh file rilis secara langsung:

| Platform | Arsitektur | C Library | File Rilis |
|---|---|---|---|
| Linux | `x86_64` | glibc | [`nouride-linux-x64.tar.gz`](@@TARBALL_BASE@@/nouride-linux-x64.tar.gz) |
| Linux | `aarch64` | glibc | [`nouride-linux-arm64.tar.gz`](@@TARBALL_BASE@@/nouride-linux-arm64.tar.gz) |
| Linux (Alpine) | `x86_64` | musl | [`nouride-linux-x64-musl.tar.gz`](@@TARBALL_BASE@@/nouride-linux-x64-musl.tar.gz) |
| Linux (Alpine) | `aarch64` | musl | [`nouride-linux-arm64-musl.tar.gz`](@@TARBALL_BASE@@/nouride-linux-arm64-musl.tar.gz) |
| macOS | Apple Silicon | tidak berlaku | [`nouride-darwin-arm64.tar.gz`](@@TARBALL_BASE@@/nouride-darwin-arm64.tar.gz) |

Tarball macOS untuk Apple Silicon (`darwin-arm64`).

### Container Image (Docker)

Buat kamu yang lebih suka deployment berbasis container:

```bash
docker pull @@DOCKER_IMAGE@@
```

Image-nya mendukung multi-arch `linux/amd64` dan `linux/arm64`. Panduan lengkapnya ada di [Docker & Compose](/id/docs/deployment/docker/).

---

## Kompilasi dari Source Code (Opsional)

Kalau kamu mau mengompilasi binary sendiri dari kode sumber:

```bash
bun run build:binary                                  # kompilasi untuk mesin lokal kamu
bun run build:binary --target linux-arm64             # cross-compile ke target tertentu
bun run build:release                                 # kompilasi keempat target Linux
```

Gateway Nougate ikut di-build kalau source-nya, `internals/nougate`, ada di clone kamu. Source itu gak publik:
tanpanya build-nya daemon yang sama tanpa gateway, dan setup gak menawarkannya.
