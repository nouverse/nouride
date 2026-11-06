---
title: Gateway Nougate
description: Gateway LLM milik Nouverse, dan satu kasus yang gak bisa dinyatakan key per-vendor.
---

**Nougate** adalah gateway LLM milik Nouverse. Dari sudut pandang Nouride, Nougate di jaringan adalah
endpoint provider biasa: gak ada integrasi khusus, dan gak ada di engine yang tahu ia bukan Anthropic.

Ia layak punya halaman sendiri karena satu alasan: ia melayani **kedua wire format dari satu deployment
dengan satu kredensial**, dan itulah kasus yang gak bisa dinyatakan sepasang `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY`.

```toml
[providers.nougate-anthropic]
kind = "anthropic"
base_url = "https://nougate.nouverse.tech/anthropic/v1"
api_key = "nougate"                 # NAMA secret → $NOUGATE

[providers.nougate-openai]
kind = "openai"
base_url = "https://nougate.nouverse.tech/openai/v1"
api_key = "nougate"                 # kredensial yang sama

[llm.defaults]
provider = "nougate-anthropic"
model = "antigravity:claude-sonnet-4-6"
```

Dua profil, satu secret, dinamai sekali dan disebut dua kali.

Simpan kredensialnya seperti yang lain:

```bash
printf '%s' "$KEY" | nouride secret set nougate --stdin
```

## Nama model

Nougate memberi namespace pada model menurut upstream-nya, jadi nama model membawa asalnya:
`antigravity:claude-sonnet-4-6`. Nouride meneruskan string itu apa adanya: `kind` menentukan bentuk
permintaan dan gak lebih, jadi model di balik endpoint berbentuk OpenAI bisa saja Claude.

Prefix-nya cuma dikesampingkan di satu tempat, yaitu saat menghitung ukuran konteks: jendelanya dicari
untuk `claude-sonnet-4-6`. Model yang jendelanya gak diketahui Nouride dianggap punya 32k, jadi set
`context_window` di `[llm]` milik agent kalau itu salah.
[Penimpaan per agent →](/id/docs/providers/configuration/#default-dan-penimpaan-per-agent)

## Siapa yang meminta, dan siapa yang menjawab

Dengan `identify = true` di profil, setiap request menyebutkan agent dan percakapan mana yang memintanya,
jadi enam agent di balik satu key tampil sebagai enam klien di laporan biaya Nougate, bukan satu. Di wire OpenAI
ia juga mengirim `prompt_cache_key`, yang dipakai provider yang merutekan dengannya untuk menjaga satu percakapan
tetap di cache tempat prefiksnya sudah ada. Kartu usage di beranda dashboard menunjukkan porsi cache tiap profil,
dan memberi tahu bila satu profil jauh lebih jarang kena cache dibanding profil lain untuk model yang sama.
[Konfigurasi →](/id/docs/providers/configuration/)

Claude hanya meng-cache sampai sebuah penanda, dan request di wire OpenAI tidak bisa membawanya, jadi Nougate yang
memasangnya (sejak Nouride 0.8.17): di tool terakhir, system prompt, dan dua pesan terbaru. Langkah agent berikutnya
membaca ulang dari cache apa yang dikirim langkah sebelumnya, sama seperti di wire Anthropic. Di wire mana pun ia
menjawab, bacaan cache dilaporkan di tempat klien wire itu membacanya.

Nougate membalas di setiap respons: `x-nougate-provider` (provider yang melayani), `x-nougate-model` (model
sebagaimana provider itu menamainya) dan `x-nougate-attempts` (berapa provider yang dicoba, `1` kecuali ia
pindah ke provider lain). Nama model berawalan hanya diarahkan ke provider itu; nama tanpa awalan bisa
dilayani provider mana pun yang punya model tersebut. Nouride menyimpan ketiganya bersama catatan usage
panggilannya, dan `nouride turns show` menampilkannya di samping tiap panggilan: `via antigravity`, atau
`via copilot, 2 tried` setelah failover.

Kalau tidak ada satu provider pun yang menjawab, error dari Nougate tetap menyebutkan provider mana saja yang
dicoba, berurutan, di `x-nougate-tried` (beserta `x-nougate-attempts`). Turn yang gagal karenanya mencatat itu di
error-nya, `(through nougate, tried antigravity, claudecode)`, untuk siapa pun yang membaca turn tersebut; di
chat cukup dibilang modelnya sedang tidak merespons.

## Menjalankannya di dalam daemon

Nougate biasanya layanan terpisah yang dijangkau lewat HTTP. Edisi **Router** membawanya di dalam
daemon Nouride, di port-nya sendiri:

```bash
@@ROUTER_INSTALL_CMD@@
```

atau image `@@DOCKER_IMAGE@@-router`. Di sana ia langsung aktif secara default di port `18256`.

**Tidak perlu API key untuk mulai.** Langkah pertama wizard setup tetap menerima API key, dan di
bawahnya ada **Use Nougate LLM Gateway**: masuk dengan akun yang sudah kamu punya: Claude (Pro atau
Max), ChatGPT (lewat Codex), GitHub Copilot, Google Gemini (lewat Antigravity) atau Kiro. Lalu daemon
menyambungkan dirinya ke gateway dengan key yang ia buat sendiri dan tidak pernah ditampilkan. Langkah
agent lalu menampilkan model yang bisa dilayani akun-akun itu. Claude, ChatGPT dan Gemini masuk lewat
OAuth: tab tempat kamu menyetujui berakhir di halaman `localhost` yang tidak terbuka, lalu alamatnya
kamu tempel kembali. Copilot dan Kiro memberi kode pendek untuk dimasukkan di situs mereka, dan wizard
selesai sendiri.

**Satu dashboard.** Setelah setup, gateway menjadi halaman **LLM Gateway** di dashboard Nouride, untuk
admin: akun, key gateway, pemakaian dan biaya, playground, provider kustom. Halaman itu terbuka dengan
login Nouride-mu; tidak ada password kedua. Sejak 0.7.10 port `18256` hanya menerima key gateway:
console miliknya di sana tidak lagi menerima login, jadi password yang dipinjamkan daemon saat start
pertama tidak bertahan lebih lama dari password yang sudah kamu ganti. Kecualinya dashboard yang tidak
bisa menampilkan halaman itu (dashboard dimatikan, atau bundle gateway dari sebelum 2026-10-15), di
mana console di `18256` (`/frontend/`) tetap punya login sendiri: username dan password yang dicetak
daemon saat start pertama, atau `INITIAL_ADMIN_USERNAME` dan `INITIAL_ADMIN_PASSWORD` milikmu.
Gateway-nya bind ke alamat di `HOST`, loopback kecuali kamu menyetelnya, jadi tool lain di jaringanmu
hanya bisa menjangkau API-nya kalau kamu membukanya lebih lebar.

Wizard menulis profilnya untukmu. Untuk mengarahkan profil lain ke situ secara manual:

```toml
[providers.local-gateway]
kind = "anthropic"
base_url = "http://127.0.0.1:18256/anthropic/v1"
api_key = "nougate"
```

Untuk memindahkan atau mematikannya, pakai `[nougate]` di `.nouride/config.toml`, atau set
`NOUGATE_IN_PROCESS=false` di `.env`. Di edisi tanpa gateway ia mati, dan menyalakannya di sana membuat
daemon berhenti saat boot, dengan kalimat yang menyatakan build ini gak membawanya:

```toml
[nougate]
in_process = false
port = 18256
```

**Yang dibelinya** terukur: proses gateway terpisah memakan 44,6 MB, dan menyematkannya membuat daemon
naik 6,0 MB, hemat 38,6 MB. Hampir semuanya adalah salinan kedua runtime Bun, yang gak bisa dibagi
antar proses dan gak dibutuhkan sebuah listener. Kode gateway itu sendiri hanya 0,3 MB dari binary
79,0 MB-nya.

**Yang dibayarnya** adalah +0,4 MB binary dan satu crash domain: bug di gateway jadi berjarak satu stack
frame dari loop agent.

Selebihnya gak berubah. Gateway yang disematkan dialamati lewat `base_url` sebuah profil provider
persis seperti yang jarak jauh, jadi `in_process = false` mengembalikannya tanpa perubahan kode.

[Varian build dan biaya terukurnya →](/id/docs/deployment/binaries/)
