---
title: Varian & Unduhan
description: Pilihan varian Nouride, spesifikasi sumber daya, serta link unduhan langsung untuk instalasi mandiri.
---

Ada dua edisi publik, masing-masing tersedia sebagai tarball Linux dan container image. Keduanya
membawa WhatsApp langsung di dalam binary.

## Varian Nouride

| Varian | Binary | Tarball | RSS Idle | Bundle | Keterangan |
|---|---|---|---|---|---|
| **Community** | ~89 MB | ~40 MB | ~58 MB | *None* | Edisi self-hosted gratis. Bisa dijalankan di server Linux, VM, atau komputer lokal mana pun. |
| **Router** | ~89 MB | ~40 MB | ~60 MB | Nougate | Community ditambah [Nougate AI Gateway](/id/docs/providers/nougate/) yang berjalan di dalam daemon pada port `18256`. |

Ukuran di atas perkiraan, diukur dari build `linux-x64` versi 0.7. Angka RSS idle diambil dari rilis
yang lebih lama dan belum diukur ulang.

### Penjelasan Varian

- **Community (Self-Hosted):** Varian standar buat kamu yang mau menjalankan agent AI di infrastruktur sendiri. Satu akun dengan password lokal, database SQLite in-process, dan konfigurasi TOML.
- **Router:** Daemon yang sama dengan gateway LLM Nougate ikut dikompilasi, jadi provider profile bisa diarahkan ke `localhost` alih-alih ke gateway di jaringan. Di edisi ini `[nougate] in_process` bawaannya `true`.

Pro menambahkan akun multi-user, masuk dengan Nouverse, dan pairing Nouride Box, plus gateway LLM yang
sama, mati sampai `[nougate] in_process = true`. Pro gak publik: gak ada unduhan atau image publik untuknya.

---

## Unduhan

Tarball diunduh dari `@@DOWNLOAD_DOMAIN@@`, satu per target. Isinya executable `nouride`, dashboard,
skill bawaan, `config.example.toml`, dan `pkg/`, service root yang dipasang oleh
[`--allow-packages`](/id/docs/deployment/system-packages/). Tarball Linux juga berisi `run/`, helper
`nouride-run` yang dipasang `install.sh` supaya [perintah tiap agent jalan sebagai user miliknya sendiri](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri).
Tarball Router menambahkan `frontend/`, console milik gateway-nya.

### Instalasi Cepat via CLI

Cara paling ringkas untuk memasang atau memperbarui Nouride di Linux:

```bash
@@INSTALL_CMD@@
```

Installer memilih build yang cocok dengan CPU dan C library mesin ini (glibc atau musl), dan berhenti
di ARM 32-bit, yang memang gak punya build.

Untuk edisi Router:

```bash
@@ROUTER_INSTALL_CMD@@
```

Wrapper itu menjalankan installer yang sama dengan `--variant router`.

### Unduh Binary Langsung

Kamu juga bisa mengunduh file rilis secara langsung:

| Platform | Arsitektur | C Library | File Rilis |
|---|---|---|---|
| Linux | `x86_64` | glibc | [`nouride-linux-x64.tar.gz`](@@TARBALL_BASE@@/nouride-linux-x64.tar.gz) |
| Linux | `aarch64` | glibc | [`nouride-linux-arm64.tar.gz`](@@TARBALL_BASE@@/nouride-linux-arm64.tar.gz) |
| Linux (Alpine) | `x86_64` | musl | [`nouride-linux-x64-musl.tar.gz`](@@TARBALL_BASE@@/nouride-linux-x64-musl.tar.gz) |
| Linux (Alpine) | `aarch64` | musl | [`nouride-linux-arm64-musl.tar.gz`](@@TARBALL_BASE@@/nouride-linux-arm64-musl.tar.gz) |
| macOS | Apple Silicon | tidak berlaku | [`nouride-darwin-arm64.tar.gz`](@@TARBALL_BASE@@/nouride-darwin-arm64.tar.gz) |

Tarball Router memakai target yang sama dengan sisipan `router`: `nouride-router-linux-x64.tar.gz`, `nouride-router-linux-arm64-musl.tar.gz`, dan seterusnya. Tarball macOS untuk Apple Silicon (`darwin-arm64`).

### Container Image (Docker)

Buat kamu yang lebih suka deployment berbasis container:

```bash
docker pull @@DOCKER_IMAGE@@          # Community
docker pull @@DOCKER_IMAGE@@-router   # Router
```

 Kedua image mendukung multi-arch `linux/amd64` dan `linux/arm64`. Panduan lengkapnya ada di [Docker & Compose](/id/docs/deployment/docker/).

---

## Kompilasi dari Source Code (Opsional)

Kalau kamu mau mengompilasi binary sendiri dari kode sumber:

```bash
bun run build:binary                                  # kompilasi untuk mesin lokal kamu
bun run build:binary --target linux-arm64             # cross-compile ke target tertentu
bun run build:release                                 # kompilasi keempat target Linux
```

`--router` membangun edisi Router, dan butuh source gateway Nougate, yang gak publik.
