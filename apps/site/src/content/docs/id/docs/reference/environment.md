---
title: Environment variable
description: Semua variable yang dibaca Nouride, apa minimalnya, dan apa yang dibutuhkan untuk menyalakan sign-in Nouverse.
---

Nouride jalan **tanpa environment sama sekali**. Daemon yang baru boot dengan
default bawaan, mencetak password admin sekali pakai ke log-nya, dan sisanya
kamu selesaikan dari browser.

Semua di bawah ini untuk kasus ketika itu gak cukup.

## Paling minimal yang tetap jalan

Dua baris, dan itu pun hanya karena install tanpa pengawasan gak punya siapa
pun yang membaca log:

```sh
INITIAL_ADMIN_USERNAME=kamu
INITIAL_ADMIN_PASSWORD=sesuatu-yang-panjang
```

Itu seluruh minimalnya. Tanpa API key provider, tanpa public URL, tanpa OAuth.
Provider model, agent, dan gateway chat semuanya diatur dari dashboard setelah
daemon hidup.

## Dua jenis variable

Ini yang paling sering membingungkan, jadi ditaruh duluan.

**Setting** dibaca daemon dengan nama tetap. Daftarnya lengkap di bawah dan
gak berubah mengikuti config kamu.

**Kredensial** dinamai oleh `config.toml` **kamu**, jadi daftarnya terbuka:

```toml
[providers.punyaku]
api_key = "kunci_saya"      # daemon membaca $KUNCI_SAYA
```

Namanya di-uppercase, tanda hubung jadi garis bawah. Kalau bentrok dengan
sesuatu di environment kamu, `$NOURIDE_SECRET_<NAMA>` juga dibaca. Environment
selalu menang atas secret store, jadi sebuah deployment bisa memaku nilai yang
gak bisa ditimpa file basi.

**File config gak pernah memegang nilainya, hanya namanya.** Itulah yang
membuat `config.toml` aman di-commit dan aman ditempel ke thread support.

## Setting

### Akun pertama

| | |
|---|---|
| `INITIAL_ADMIN_USERNAME` | Username akun yang dibuat saat boot pertama |
| `INITIAL_ADMIN_PASSWORD` | Password-nya |

Dibaca **hanya selama tabel user masih kosong**, dan diabaikan selamanya
setelah itu. Kalau gak diisi, daemon membuat password dan mencetaknya sekali,
tepat ketika kamu menonton, keliru ketika gak ada yang menonton. Tambahkan
`INITIAL_ADMIN_MUST_CHANGE=1` supaya akun itu wajib mengganti password saat
login pertama.

### Tempat dia mendengarkan

| | default | |
|---|---|---|
| `PORT` | `18254` | Dashboard, control API dan `/health`, satu port |
| `HOST` | `127.0.0.1` | Loopback. Container wajib `0.0.0.0` atau port yang dipublish gak menjangkau apa pun, image-nya sudah begitu |

### Alamat yang dijangkau orang

| | |
|---|---|
| `NOURIDE_PUBLIC_URL` | mis. `https://agents.example.com` |

Hanya perlu kalau itu **bukan** `host:port`: di belakang reverse proxy, atau
port map container. URL webhook dan redirect OAuth dua-duanya dibangun dari
sini, dan dua-duanya gak menjangkau siapa pun tanpanya.

### Tempat dia menyimpan

| | default |
|---|---|
| `NOURIDE_DATA_DIR` | `./.nouride/data`: database, secret, lampiran, backup |
| `NOURIDE_AGENTS_DIR` | `./.nouride/agents`: persona pack |
| `NOURIDE_HOME` | Menamai seluruh root install |
| `NOURIDE_CONFIG` | Menamai satu file config langsung |

### Kunci penyimpanan secret

| | |
|---|---|
| `NOURIDE_ENCRYPTION_KEY` | Kunci yang mengenkripsi penyimpanan secret (0.8.19): 32 byte acak sebagai base64 (`openssl rand -base64 32`) atau sebagai 64 digit hex. `install.sh` menyimpannya di `/etc/nouride/nouride.env` milik root, yang dimuat unit-nya; di container, isi di sini |
| `NOURIDE_ENCRYPTION_KEY_FILE` | File yang memuatnya, sebagai gantinya, misalnya Docker secret |

Simpan di luar volume, dan di luar backup `.nouride/`: itulah yang membuat salinan datanya gak bisa membuka
penyimpanannya. Tanpa kunci itu, atau password backup, penyimpanannya gak bisa dibuka. Kalau gak diberi kunci, Nouride
membuat satu di samping datanya, bilang begitu di `nouride doctor`, dan pindah ke kunci yang diberikan belakangan saat
start berikutnya. Dia mengeluarkan kunci itu dari environment-nya sendiri begitu dibaca, jadi gak ada yang dijalankannya
yang mewarisinya. [Secret →](/id/docs/architecture/storage/#secret)

### Lain-lain

| | |
|---|---|
| `TZ` | Timezone IANA untuk waktu agent dan cron. Default UTC |
| `LOG_LEVEL` | `debug`, `info`, `warn`, atau `error` |
| `NOUGATE_IN_PROCESS` | `true` atau `false`, menimpa `[nougate] in_process`. Hanya edisi Router yang punya gateway untuk dijalankan |
| `NOUGATE_HOME` | Edisi Router: gateway bawaan menyimpan state-nya di `$NOUGATE_HOME/data`. Default `.nouride/nougate` |
| `NOURIDE_SUPERVISOR_MODE` | Nilai apa pun berarti ada yang di luar Nouride (pm2, supervisord, runit) yang menyalakan ulang daemon saat dia keluar, jadi `nouride restart` dan update boleh jalan. Isi hanya kalau itu memang benar. Gak dibaca di dalam container |
| `NOURIDE_WA_LOG_LEVEL` | `debug` menaikkan log bridge WhatsApp sampai paling detail, di stderr. Default `warn` |
| `NOURIDE_WA_SEND_TIMEOUT_MS` | Berapa lama satu pengiriman WhatsApp boleh berjalan sebelum dianggap gagal. Default `60000` |
| `NOURIDE_MCP_CATALOG_URL` | Tempat Explore, `nouride mcp search`, dan `mcp_search` mencari server MCP. Default `https://service.nouverse.tech/mcp-catalog`, mirror registry MCP resmi milik Nouverse. Salinan katalog lain boleh ada di jaringanmu sendiri; kosong mematikan pencariannya |

### Di jaringan tanpa internet langsung

Pod terkelola dan sebagian jaringan kantor mengarahkan trafik keluar lewat
proxy. **Semua** yang dipanggil daemon lewat situ: provider model, web search,
pengiriman webhook, dan sign-in Nouverse kalau kamu pakai.

```sh
HTTP_PROXY=http://proxy.internal:8888
HTTPS_PROXY=http://proxy.internal:8888
NO_PROXY=localhost,127.0.0.1
```

Tanpa ini di jaringan seperti itu, semua panggilan keluar gagal dengan
`TypeError: Unable to connect`: yang menyebut kerusakan jaringan, bukan setting
yang kurang, dan gampang memakan waktu setengah hari.

Perintah yang dijalankan para agent gak mewarisinya: `exec` memberi sebuah
perintah daftar variabel yang tetap, dan setelan proxy gak termasuk di dalamnya.

## Sign in dengan Nouverse

Opsional. Lewati seluruh bagian ini dan gak ada yang berubah: halaman login
tetap username dan password, persis seperti sebelumnya. Mati kecuali issuer-nya
diisi.

Yang dia tambahkan adalah tombol **Continue with Nouverse**: begitulah install
self-hosted mendapat sign-in Google dan GitHub yang mustahil dia tawarkan
sendiri. Dia gak bisa mendaftarkan aplikasi Google untuk domain yang bukan
miliknya, jadi dia mempercayai issuer yang sudah memegang kredensial itu, dan
orangnya memilih provider di halaman login **issuer tersebut**.

:::caution[Hanya edisi Pro yang membacanya]
Variabel-variabel ini ada di semua build, tapi hanya edisi **Pro** yang
punya alurnya. Di build Community atau Router, menyetel `NOURIDE_OAUTH_ISSUER` membuat daemon
**menolak boot**, bukan mengabaikannya, kodenya gak ikut dikompilasi, jadi gak ada yang bisa
dikonfigurasi. [Edisinya →](/id/docs/deployment/binaries/#varian-nouride)
:::

### Yang dibutuhkan

| | |
|---|---|
| `NOURIDE_PUBLIC_URL` | **Wajib di sini.** Redirect-nya gak bisa dibangun tanpa ini |
| `NOURIDE_OAUTH_ISSUER` | mis. `https://service.nouverse.tech/api/auth` |
| `NOURIDE_OAUTH_CLIENT_ID` | Diterbitkan untuk install **ini** |
| `NOURIDE_OAUTH_SECRET_NAME` | **Nama** secret-nya, bukan secret-nya |
| `NOURIDE_OAUTH_LABEL` | Tulisan di tombol. Default `Nouverse` |

Client secret gak diisi langsung. `SECRET_NAME` menamainya, dan daemon membaca
variable yang nama itu petakan, `nouverse_oauth` membaca `$NOUVERSE_OAUTH`.

```sh
NOURIDE_PUBLIC_URL=https://agents.example.com
NOURIDE_OAUTH_ISSUER=https://service.nouverse.tech/api/auth
NOURIDE_OAUTH_CLIENT_ID=nvo_...
NOURIDE_OAUTH_SECRET_NAME=nouverse_oauth
NOURIDE_OAUTH_LABEL=Nouverse

NOUVERSE_OAUTH=secret-yang-kamu-terima
```

### Mendaftarkan

Yang kamu berikan ke issuer satu URL, dan dia membandingkannya **byte per
byte**:

```
<NOURIDE_PUBLIC_URL>/api/control/auth/oauth/callback
```

Beda satu garis miring di ujung = login gagal. Untuk Nouverse, prosedurnya ada
di `docs/OAUTH_PROVIDER.md` di repositori `nouverse-core`.

### Identitas gak pernah membuat akun

Email yang dikembalikan dicocokkan dengan username akun yang **sudah ada**, dan
kecocokan itu wajib. Provider mengautentikasi semua user yang dia punya, bukan
hanya yang dikenal install kamu, jadi kalau login bisa membuat akun, siapa pun
yang punya akun di issuer itu dan menemukan URL kamu langsung punya akun di
daemon kamu.

Jadi: buat akunnya dulu, dengan email orang itu sebagai username, baru dia masuk
lewat tombol.

### Isi ketiganya atau gak sama sekali

Setengah-setengah ditolak saat boot, bukan ditampilkan sebagai tombol yang
gagal. Sama untuk issuer yang terisi tapi `NOURIDE_PUBLIC_URL` kosong, yang itu
akan menggambar tombol yang berfungsi, mengautentikasi penggunanya, lalu ditolak
saat pertukaran token, yaitu saat paling gak berguna untuk mengetahuinya.

## Mematikan login password

```sh
NOURIDE_PASSWORD_LOGIN=false
```

Halaman login kemudian hanya menampilkan **Continue with Nouverse**: tanpa
kolom username, tanpa kolom password.

**Ditolak saat boot kecuali blok Nouverse di atas lengkap**, karena kalau gak,
gak ada yang bisa masuk sama sekali. Gak ada yang dihapus: password yang
sudah ada tetap disimpan dan berfungsi lagi begitu kamu menyalakannya kembali.

Ada tempat yang lebih gampang untuk ini: **Dashboard → Settings → Users**, di situ admin
dapat sebuah switch. Yang itu berlaku seketika, dan dia menolak kalau client
secret-nya ternyata gak menghasilkan apa-apa, pemeriksaan yang gak bisa
dilakukan file config, karena file dibaca sebelum secret store terbuka.

## Kredensial yang dinamai config kamu

Gak ada daftar tetap. Ini contoh; simpan yang memang dirujuk `config.toml`
kamu.

```sh
# Provider model. Satu kunci bisa melayani beberapa profil:
#   [providers.nougate-anthropic]  api_key = "nougate"
#   [providers.nougate-openai]     api_key = "nougate"
NOUGATE=

# Profil buatanmu bisa menyebut variabel konvensional, mis. api_key = "anthropic_api_key"
ANTHROPIC_API_KEY=

# Satu per koneksi chat; inilah yang memberi tiap agent bot-nya sendiri:
#   [gateways.telegram.nouva]  token = "telegram-nouva"
TELEGRAM_NOUVA=
DISCORD_MAIN=

# Web search: [security.web] search_api_key = "brave_search_api_key"
BRAVE_SEARCH_API_KEY=

# Enkripsi sesi WhatsApp, 64 karakter hex: openssl rand -hex 32
#   [gateways.whatsapp.main]  encryption_key = "wa-encryption-key"
WA_ENCRYPTION_KEY=
```

## Bukan untuk deployment

`NOURIDE_URL` dan `NOURIDE_TOKEN` mengarahkan CLI `nouride` ke daemon di mesin
lain. Tempatnya di shell kamu, bukan di environment sebuah daemon.

`NOURIDE_ALLOW_SCHEMA_DRIFT=1` membuat daemon mau start di atas database yang
skemanya gak dikenali build ini. Itu untuk menghidupkan mesin lagi, bukan
perbaikan: ia gak menerima apa pun, jadi start berikutnya tanpa variabel ini
akan menolak lagi. Pesan penolakannya menyebut jalan keluar yang sebenarnya:
build yang cocok, sebuah snapshot, atau `nouride db adopt`.

Bridge WhatsApp di dalam daemon mendapat direktori sesi dan kuncinya dari
config, gak pernah dari environment.

## Yang didapat perintah para agent

Perintah yang dijalankan agent gak mendapat environment daemon, jadi gak ada key
milik daemon yang bisa bocor ke situ. Yang didapatnya daftar tetap:

- `PATH`, dengan `.nouride/bin` paling depan. `NOURIDE_PATH` berisi nilai yang
  sama dan `NOURIDE_BIN` menunjuk `.nouride/bin`, jadi login shell yang
  me-reset `PATH` mendapatkannya kembali;
- `HOME`, `LANG`, `LC_ALL`, `TZ` dan `TERM`, dari daemon;
- `SSH_AUTH_SOCK`, dari daemon, hanya untuk agent yang pack-nya bilang `ssh_agent = true` di bawah
  `[security]`, sejak 0.7.10, saat setiap perintah setiap agent berhenti mendapatkannya;
- `TMPDIR`, `TMP` dan `TEMP`, diarahkan ke scratchpad agent;
- `NOURIDE_CREDENTIALS_DIR`, dan secret yang diikat `exec_secrets` agent itu ke perintah tersebut;
- `NOURIDE_AGENT_ID`, `NOURIDE_GATEWAY_ID` dan `NOURIDE_CHAT_ID` pada apa yang
  dijalankan tool `nouride`, supaya panggilan CLI tahu dari percakapan mana ia
  datang.

Yang `NOURIDE_*` diset oleh daemon, dan mengisinya sendiri gak berguna. Di bawah
systemd atau di container, `HOME` adalah `.nouride/home`, sejak 0.6.

Kalau `HOME` adalah `.nouride/home`, daemon juga mengarahkan para installer ke
`.nouride`, jadi instalasi global mendarat di `.nouride/bin` tanpa root dan
tanpa flag: `NPM_CONFIG_PREFIX`, `BUN_INSTALL_BIN`, `UV_TOOL_BIN_DIR`,
`PIPX_BIN_DIR`, `GOBIN`, `CARGO_INSTALL_ROOT`, `XDG_BIN_HOME` dan beberapa
lainnya. `PATH` lalu juga membawa Python env bersama setelah `.nouride/bin`,
serta `~/.local/bin` dan `~/.cargo/bin` di ujungnya. Setelan installer ini
pengecualian: nilai yang kamu taruh di environment daemon menang dan itulah yang
didapat para agent, kecuali kalau nilainya menunjuk direktori yang gak bisa
ditulis daemon.

Kalau [tiap agent punya user sendiri](/id/docs/architecture/overview/#tiap-agent-punya-user-sendiri) (service Linux
dengan helper `nouride-run`), `HOME` adalah folder milik agent itu, `workspace/private/<id>`, dan setelan installer
diarahkan ke `~/.local` miliknya: `NOURIDE_BIN` adalah `~/.local/bin`, paling depan di `PATH`-nya, diikuti Python env
miliknya, lalu `.nouride/bin` bersama di belakangnya, untuk dijalankan dan bukan untuk ditulis. CLI agent eksternal dan
server MCP stdio milik agent dapat `HOME` yang sama. Di Docker, macOS, atau tanpa helper, semua agent dapat
`.nouride/home`, seperti di atas.
