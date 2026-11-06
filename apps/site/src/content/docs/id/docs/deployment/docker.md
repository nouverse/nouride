---
title: Docker & Compose
description: Menjalankan daemon di container, file compose, isi image, dan cara menjangkau mesin lain.
---

```bash
mkdir -p ~/nouride && cd ~/nouride
docker run -d --name nouride --restart unless-stopped --stop-timeout 45 \
  -p 127.0.0.1:@@PORT@@:@@PORT@@ \
  -e HOST=0.0.0.0 \
  -v "$PWD/nouride:/app/.nouride" \
  @@DOCKER_IMAGE@@
```



Gak ada yang perlu dikonfigurasi lebih dulu. Instalasi baru menyala tanpa `config.toml` dan tanpa
agent, dan semua setelah itu terjadi di browser.

```bash
docker logs -f nouride          # password pertama tercetak di sini
```

:::caution[`HOST=0.0.0.0` bukan opsional di container]
Loopback adalah default yang benar untuk daemon yang jalan langsung di host, tapi container yang bind
ke loopback berarti bind ke loopback *miliknya sendiri*, dan port yang kamu publikasikan gak mencapai
apa pun. Pernah diverifikasi dari arah sebaliknya: `curl` dari host gak dapat apa-apa sementara
permintaan yang sama di dalam container dijawab.

Image-nya sudah menyetelnya; flag di atas penting ketika kamu menimpa environment-nya.
:::

`--stop-timeout 45` ada karena alasan yang sama dengan `stop_grace_period` di bawah. Docker menunggu
10 detik lalu mengirim `SIGKILL`, lebih pendek dari masa drain daemon sendiri yang 30 detik: giliran
yang masih jalan saat container berhenti akan dibunuh sebelum sempat menyelesaikan langkahnya dan
memberi tahu.

## Compose

```yaml
services:
  nouride:
    image: @@DOCKER_IMAGE@@
    container_name: nouride
    restart: unless-stopped
    stop_grace_period: 45s
    ports:
      - "127.0.0.1:@@PORT@@:@@PORT@@"
    volumes:
      - ./nouride:/app/.nouride
```

Port-nya dipublikasikan hanya di loopback host, sama seperti instalasi native: buka dasbor di mesin itu
sendiri, atau tunnel dari mesinmu dengan `ssh -L @@PORT@@:127.0.0.1:@@PORT@@ kamu@server-kamu`. Supaya bisa
dijangkau dari mesin lain, hapus `127.0.0.1:` (`"@@PORT@@:@@PORT@@"`). Dasbor lalu menjawab siapa pun yang bisa
menjangkau host, dan port yang dipublikasikan Docker melewati firewall seperti `ufw`. Untuk alamat publik, biarkan di loopback dan pasang reverse proxy dengan TLS di depannya, di mesin yang sama
(Caddy, nginx, Cloudflare Tunnel): dasbor itu halaman login, dan login lewat HTTP biasa berarti password lewat tanpa enkripsi.

### Compose untuk production

Untuk deployment production di mana kamu ingin healthcheck otomatis, rotasi log, dan substitusi variabel environment:

```yaml
services:
  nouride:
    image: @@DOCKER_IMAGE@@
    container_name: nouride
    restart: unless-stopped
    stop_grace_period: 45s
    ports:
      - "127.0.0.1:${PORT:-@@PORT@@}:${PORT:-@@PORT@@}"
    # Setiap kredensial masuk ke container lewat sini. NAMA secret dipilih di config.toml:
    # `api_key = "nougate"` membaca $NOUGATE, jadi gak bisa didaftar di bawah `environment`.
    env_file:
      - path: .env
        required: false
    environment:
      - HOST=${HOST:-0.0.0.0}
      - PORT=${PORT:-@@PORT@@}
      - LOG_LEVEL=${LOG_LEVEL:-info}
    volumes:
      # Seluruh instalasi sebagai satu mount: config, database, secret, agent pack, workspace.
      - ./nouride:/app/.nouride:z
    healthcheck:
      test: ["CMD", "bun", "-e", "await fetch('http://localhost:@@PORT@@/health').then(r=>process.exit(r.ok?0:1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

**Kenapa `env_file` dan bukan hanya `environment`.** Compose membaca `.env` bagaimanapun, tapi hanya
untuk mensubstitusi `${...}` di file compose itu sendiri, jadi kunci apa pun yang gak juga terdaftar di
bawah `environment` akan diabaikan diam-diam oleh daemon. Dan daftar di bawah `environment` sengaja
pendek, karena nama variabel kredensial dipilih di `config.toml` dan gak bisa didaftar di sini.

Kamu juga bisa menjauhkan kredensial dari `.env` sepenuhnya dan menyetelnya dari dashboard. Nilainya
mendarat di penyimpanan secret, `.nouride/data/secrets.enc`, di volume yang di-mount, terenkripsi. Simpan
kuncinya di luar volume, supaya backup `.nouride/` tidak membawa kunci: `NOURIDE_ENCRYPTION_KEY` di `.env`
(`openssl rand -base64 32`), atau Docker secret yang disebut di `NOURIDE_ENCRYPTION_KEY_FILE`. Kalau dua-duanya
tidak ada, Nouride membuat kunci sendiri dan menyimpannya di volume, dan `nouride doctor` bilang begitu; kalau
kunci diberikan belakangan, Nouride pindah ke kunci itu saat start berikutnya. Simpan salinan kuncinya: tanpa
kunci itu, atau password backup (halaman Secrets di dashboard bisa mengaturnya), penyimpanan secret tidak bisa dibuka.

## Satu mount, satu backup

```
.nouride/
├── config.toml
├── data/          SQLite dan secrets.enc - 0600; control token - 0640, kredensial CLI (bisa dibaca grup)
├── agents/        persona pack
├── memory/        vault memori, begitu sudah ada isinya
├── home/          HOME para agent: ~/.ssh, login CLI
├── bin/ lib/ opt/ yang dipasang para agent untuk diri mereka sendiri
└── workspace/     hasil kerja para agent
```

Control token-nya 0640, bukan 0600, supaya di instalasi native anggota grup service bisa menjalankan CLI tanpa
sudo. Daemon mengembalikannya ke 0640 setiap kali start, dan `nouride doctor` tidak menerima yang lebih terbuka.

Untuk menyimpan keluaran para agent di disk yang berbeda dari state daemon, mount `workspace` terpisah
dan arahkan `workspace_dir` ke situ. Ketiga path itu kunci config terpisah justru untuk ini.

## Image yang mana

Dua yang publik, dan halaman ini memakai yang pertama di seluruh contohnya. Yang ketiga privat:

| Package | Isinya | Keterangan |
|---|---|---|
| `@@DOCKER_IMAGE@@` | Edisi Community | Image standar untuk self-hosting |
| `@@DOCKER_IMAGE@@-router` | Community plus gateway Nougate, dalam proses yang sama | Gateway di port 18256, langsung aktif |
| `@@DOCKER_IMAGE@@-pro` | Edisi Pro: akun multi-user dan masuk dengan Nouverse | **Privat**, gak bisa di-pull tanpa akses |

Image router menyimpan state gateway-nya, yaitu akun, provider, dan `nougate.db`, di
`./nouride/nougate/data/`, tetap di dalam satu volume mount yang sama.

Menyetel `NOURIDE_OAUTH_ISSUER` pada salah satu image publik **ditolak saat boot**, dengan kalimat yang
menyatakan build ini gak punya sign-in eksternal. Ia gak diabaikan, dan gak ada environment variable
yang bisa menyalakannya: kodenya memang gak ada di dalam.

[Varian dan spesifikasi masing-masing →](/id/docs/deployment/binaries/)

### Menjalankan varian Router

Kalau menjalankan `@@DOCKER_IMAGE@@-router`, dashboard gateway-nya adalah halaman **LLM Gateway**
di dashboard Nouride pada `@@PORT@@`, dengan login yang sama. Publish port `18256` juga hanya untuk yang
memanggil gateway secara langsung: tool lain dengan key gateway, atau console mandirinya di
`http://<ip-kamu>:18256/frontend/`:

```yaml
services:
  nouride:
    image: @@DOCKER_IMAGE@@-router
    container_name: nouride
    restart: unless-stopped
    stop_grace_period: 45s
    ports:
      - "127.0.0.1:@@PORT@@:@@PORT@@"
      - "127.0.0.1:18256:18256"   # Nougate AI Router & Web Console (/frontend/)
    volumes:
      - ./nouride:/app/.nouride
```

Di edisi Router, gateway in-process **langsung aktif secara default** di port `18256`, jadi gak perlu
`config.toml` untuknya. Wizard setup menyambung ke gateway tanpa API key: masuk dengan akun Claude,
ChatGPT, Copilot, Gemini atau Kiro lewat **Use Nougate LLM Gateway**.
[Halaman Nougate →](/id/docs/providers/nougate/#menjalankannya-di-dalam-daemon)

## Registry

Kedua image publik bisa di-pull tanpa login. Paket privat, atau image yang kamu build dan push sendiri
ke registry privat, butuh login:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
```

PAT klasik, atau token fine-grained dengan `read:packages` dan gak lebih. Untuk Kubernetes, kredensial
yang sama menjadi `imagePullSecret`:

```bash
kubectl create secret docker-registry ghcr \
  --docker-server=ghcr.io --docker-username=<github-username> --docker-password="$GHCR_TOKEN"
```

## Isi image, dan apa yang gak ada

Bun, plus `bash`, `openssh-client`, `util-linux` (untuk `script(1)`, yang membuat sesi interaktif
bekerja), `ripgrep`, `su-exec` untuk penurunan hak akses di entrypoint, dan `socat` untuk service
paket. Gak lebih: gak ada `git`, gak ada `kubectl`, gak ada Python, gak ada CLI cloud.

Daemon berjalan sebagai uid 1000 (`bun`), jadi `apk add` bukan untuk agent. Paket sistem lewat
`nouride-pkg` (0.8.15): entrypoint, yang root sebelum menyerahkan container, menjalankannya, agent
meminta paket dengan namanya (`nouride pkg install ffmpeg`), dan kamu menyetujui setiap perubahan, kecuali
agent-nya `trusted`.
Yang dipasang agent disimpan di `.nouride/system-packages` di volume dan dipasang lagi saat container
dibuat ulang, seperti yang terjadi di setiap update. `NOURIDE_SYSTEM_PACKAGES=off` mematikannya;
selengkapnya di [Paket sistem](/id/docs/deployment/system-packages/#di-docker). Untuk menanam paket
langsung di image:

```bash
docker build --build-arg EXTRA_PACKAGES="git kubectl helm" -t nouride .
```

Yang dipasang agent untuk dirinya sendiri tetap jalan, dan mendarat di `.nouride/bin` di dalam volume,
jadi bertahan saat container dibuat ulang: `bun add -g`, binary rilis yang dipasang dengan
`install -m 755`, dan instalasi lewat `npm`, `pipx`, `go`, atau `cargo` begitu tool-tool itu ada di
image. Base image-nya mengarahkan `bun add -g` ke `/usr/local/bin`, yang gak bisa ditulis uid 1000;
daemon mengganti setelan yang gak bisa ia tulis dengan miliknya sendiri.

Untuk pekerjaan infrastruktur lewat SSH, biasanya kamu butuh lebih sedikit dari dugaan, `kubectl`
berjalan di mesin ujung sana, bukan di sini.

### Server MCP di dalam container

Apa yang dibutuhkan sebuah server untuk jalan menentukan langkahmu, dan Explore menyebutnya di tiap kartu:

- **Server remote** (Notion, Linear, dan kebanyakan yang di-host) gak butuh apa pun di image. Yang login dengan akun
  akan tampil **needs login** setelah ditambahkan; tekan **Connect**. Login-nya kembali ke `NOURIDE_PUBLIC_URL`, atau,
  kalau gak diisi, kamu tempel alamat terakhir yang dibuka browser ke kartunya.
- **Server Python** (`uvx`) butuh uv, dan uv itu satu binary: agent bisa memasangnya sendiri ke volume, jadi bertahan
  saat container dibuat ulang: `wget -qO- https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=$NOURIDE_BIN UV_NO_MODIFY_PATH=1 sh`.
  Image-nya punya `wget`, bukan `curl`.
- **Server npm** (`npx`) butuh Node.js, yang di sini adalah paket sistem: agent memasangnya lewat
  `nouride pkg install nodejs npm` setelah kamu setujui, atau build image dengan `--build-arg EXTRA_PACKAGES="nodejs npm"`.
  `node` yang sudah ada di image adalah pengganti dari Bun, tanpa `npx`.
- **Server yang jalan sebagai image** (`docker`) gak bisa dijalankan dari dalam container. Pakai bentuk npm atau
  Python-nya kalau ada.

### Memori

Instalasi native di bawah systemd menaruh setiap perintah agent di cgroup sendiri, di bawah daemon, jadi perintah yang
rakus memori itulah yang dihentikan (0.7.19). Container gak punya unit untuk dipisah: perintah agent jalan di samping
daemon, dan `nouride doctor` menyebutnya. Beri container batas memori, supaya perintah yang lepas kendali dihentikan di
dalamnya dan gak menekan host, dan entrypoint menjalankan daemon lagi kalau ikut terhenti:

```yaml
services:
  nouride:
    mem_limit: 2g
```

CLI-nya juga ada di image, sebagai `docker exec nouride nouride status`. Ia jalan sebagai uid 1000
meskipun `docker exec` itu root, jadi gak ada yang ditulisnya berakhir dimiliki root.

## Menjangkau mesin lain lewat SSH

Image-nya membawa `openssh-client`. Dua hal yang gak bisa dibawanya harus datang dari luar.

**Key-nya.** Teruskan socket ssh-agent kamu alih-alih me-mount private key. Key di disk tanpa passphrase
adalah rahasia yang bisa dibaca proses ini dan disalin subprocess mana pun yang dijalankannya; sebuah
socket adalah path yang ujung satunya memutuskan, per permintaan, apakah akan menandatangani. Ia
menandatangani dengan setiap key yang dipegang agent untuk siapa pun yang meminta, jadi sejak 0.7.10
sebuah agent baru diberi `SSH_AUTH_SOCK` kalau pack-nya bilang `ssh_agent = true` di bawah
`[security]`; agent lain gak melihatnya.

```yaml
services:
  nouride:
    environment:
      - SSH_AUTH_SOCK=/ssh-agent
    volumes:
      - ${SSH_AUTH_SOCK}:/ssh-agent          # Linux
      # macOS (Docker Desktop / OrbStack) mengekspos agent host di path tetap:
      # - /run/host-services/ssh-auth.sock:/ssh-agent
```

**Host key.** HOME para agent adalah `/app/.nouride/home`, di dalam volume, jadi `~/.ssh`
(`known_hosts`-nya, config yang menamai host, kunci yang dibuat agent) bertahan saat container dibuat
ulang tanpa mount tambahan. Sebelum 0.6 ia ada di layer container sendiri dan setiap host kembali gak
dikenal setelah tiap pembuatan ulang.

## Sesi interaktif

Ini bekerja di container, dan itu bukan hal kecil. `exec` berjalan dengan stdin tertutup, default yang
benar untuk perintah sekali jalan, tapi tool `session` membuka proses persisten yang bisa diketik
agent, sehingga `ssh host`, `kubectl exec -it`, `vim` dan prompt password `sudo` semuanya terjangkau.

Terminalnya berasal dari `script(1)` di `util-linux`, yang ada di image: proses anak yang memeriksa
`isatty` melihat pty sungguhan. Instalasi Linux atau macOS native mendapatkannya dari `script` miliknya sendiri.

## Restart

```bash
docker compose restart
docker compose pull && docker compose up -d      # upgrade
```

Restart dari dashboard, atau `nouride restart` dari agent, juga bekerja di dalam container:
entrypoint image-nya mengawasi daemon dan menyalakannya lagi dalam sedetik, tanpa me-restart
container-nya, apa pun restart policy-nya.

Dari rilis 0.7, `pull` saja akan ditolak saat start pertama: jalankan tag `0.8.0` sekali di volume yang sama dulu,
dan dari yang lebih lama dari 0.7.28, tag `0.7` sekali sebelumnya. Dari 0.7.x: lihat [Upgrade ke v0.8](/id/docs/deployment/upgrading-to-0-8/).

[Memperbarui container →](/id/docs/deployment/updating/#memperbarui-container)

## WhatsApp

**WhatsApp berjalan di dalam daemon di setiap image**: gak ada container bridge terpisah yang perlu dijalankan, dan gak ada image bridge yang diterbitkan.

[WhatsApp →](/id/docs/gateways/whatsapp/)
