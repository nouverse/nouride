---
title: Profil provider
description: Sebuah profil adalah endpoint, bukan vendor, dan satu kredensial bisa melayani beberapa.
---

Unit konfigurasi LLM adalah **endpoint**: sebuah wire format, sebuah base URL, dan sebuah kredensial.

```toml
[providers.nougate-anthropic]
kind = "anthropic"                                     # wire format-nya, bukan perusahaannya
base_url = "https://nougate.nouverse.tech/anthropic/v1"
api_key = "nougate"                                    # NAMA secret, bukan nilainya

[providers.nougate-openai]
kind = "openai"
base_url = "https://nougate.nouverse.tech/openai/v1"
api_key = "nougate"                                    # kredensial yang sama
```

Sebuah agent lalu menyebut `provider = "nougate-anthropic"`, dan memindahkannya ke deployment lain cukup
satu kata.

Bentuk sebelumnya, satu variabel lingkungan per vendor (`ANTHROPIC_API_KEY` dan `OPENAI_API_KEY`),
sama sekali gak bisa menyatakan ini. Sebuah kredensial milik sebuah **base URL**, dan satu key gateway
melayani kedua endpoint protokolnya. Menamai secret sekali lalu menyebutnya dua kali menyatakan persis
itu.

## `kind` hanya wire format

Dua nilai, dan keduanya bukan nama perusahaan:

| | |
|---|---|
| `anthropic` | bentuk Anthropic Messages API |
| `openai` | bentuk OpenAI Chat Completions |

Model di balik `antigravity:claude-sonnet-4-6` pada endpoint berbentuk OpenAI tetaplah Claude, dan gak
ada di engine yang perlu peduli. Sebuah proxy bisa melayani salah satu format.

## Profil yang umum

```toml
[providers.anthropic]
kind = "anthropic"
base_url = "https://api.anthropic.com/v1"
api_key = "anthropic_api_key"

[providers.openai]
kind = "openai"
base_url = "https://api.openai.com/v1"
api_key = "openai_api_key"
max_tokens_field = "max_completion_tokens"   # khusus API OpenAI sendiri; lihat di bawah

[providers.openrouter]
kind = "openai"
base_url = "https://openrouter.ai/api/v1"
api_key = "openrouter"
headers = { "HTTP-Referer" = "https://nouverse.tech" }

# Apa pun yang berbicara bentuk OpenAI di jaringan kamu sendiri.
[providers.ollama]
kind = "openai"
base_url = "http://127.0.0.1:11434/v1"
api_key = "ollama"
```

`headers` untuk header literal non-rahasia. Header dikirim apa adanya dan tetap terbaca di config,
jadi kredensial tempatnya di `api_key` (nama secret), bukan di sini. (`headers` milik server MCP per
agent diperiksa dan ditolak kalau nilainya terlihat seperti kredensial; milik profil provider gak.)

`identify = true` menyebutkan agent dan percakapan mana yang meminta setiap request: `user`,
`prompt_cache_key` dan header `x-client-id` di format OpenAI, `metadata.user_id` di format Anthropic.
Gateway seperti Nougate membedakan klien dan sesinya dengan itu, dan OpenAI mengirim request sebuah
percakapan ke cache tempat awalannya sudah ada. Mati kecuali diisi, karena server yang ketat menolak
field yang gak dikenalnya.

`max_tokens_field` adalah field tempat batas output sebuah balasan dikirim, di format OpenAI. API OpenAI sendiri
menolak `max_tokens` untuk model-model barunya (keluarga GPT-5 salah satunya) dengan `Unsupported parameter:
'max_tokens'`, dan menerima `max_completion_tokens` untuk semua model chat-nya. Server lain yang bicara format yang
sama (OpenRouter, Ollama, vLLM, llama.cpp, Nougate) bisa jadi cuma kenal `max_tokens`, dan itulah yang dikirim kalau
key ini gak ditulis. Kamu gak perlu menulisnya sendiri: setup, dashboard, dan `nouride provider add` menulis
`max_tokens_field = "max_completion_tokens"` untuk profil di `https://api.openai.com/v1`, dan start pertama setelah
update menuliskannya ke profil yang dibuat sebelumnya, sekali, dan mencatatnya di log. Profil yang sudah menulis
`max_tokens_field`, apa pun nilainya, tetap dengan nilainya. `nouride config check` menampilkan profil yang batasnya
dikirim di `max_completion_tokens`, dan bilang kalau start berikutnya akan menulis key ini. Format Anthropic cuma
punya satu field, `max_tokens`, jadi profil Anthropic yang minta `max_completion_tokens` gak bisa dimuat.

`cache_minutes` adalah berapa lama endpoint menyimpan cache prompt sebuah percakapan setelah request terakhirnya.
Nouride membersihkan output tool lama dari riwayat percakapan saat itu gak makan biaya, dan salah satu saatnya adalah
ketika percakapan sudah diam lebih lama daripada umur cache endpoint-nya: request berikutnya toh dibaca penuh. Profil
di `https://api.anthropic.com/v1` dibaca `cache_minutes = 5` tanpa perlu kamu tulis, yaitu umur cache yang
didokumentasikan Anthropic untuk jenis cache yang diminta Nouride. Endpoint lain dibaca `60` kecuali key ini kamu isi:
menganggap cache masih ada padahal sudah hilang cuma membuat output lama tinggal sedikit lebih lama, sedangkan
sebaliknya membuang cache yang lebih murah dibaca. API OpenAI sendiri termasuk di situ, karena dokumentasinya menyebut
umur cache dari beberapa menit sampai sehari, tergantung model dan pengaturan organisasinya. Isi `cache_minutes` kalau
kamu tahu angkanya; `0` untuk endpoint yang gak menyimpan cache sama sekali.

## Mengelolanya

Dari dashboard: **Models** (khusus admin), endpoint, wire format, kredensial. Atau:

```bash
nouride provider                                       # profil, dan mana yang punya kredensial
nouride provider add nougate-anthropic --kind anthropic \
  --url https://nougate.nouverse.tech/anthropic/v1 --stdin
nouride provider rm nougate-anthropic
```

![Halaman Models: tiap profil provider, nama kredensialnya, dan agent yang memakainya](/media/dashboard-models.png)

Key-nya dibaca dari stdin, bukan diambil sebagai argumen. Key di baris perintah mendarat di riwayat
shell, di output `ps`, dan di log CI mana pun yang menggemakan perintahnya.

`add` mencoba endpoint-nya dengan key itu dulu dan menolak menulis profil yang gak menjawab;
`--no-probe` tetap menulisnya, untuk endpoint yang belum nyala. CLI maupun dashboard menyimpan key
profil baru sebagai `<profil>_api_key`. Untuk memakai satu kredensial di dua profil, seperti di awal
halaman ini, arahkan `api_key` profil kedua ke secret milik profil pertama di `config.toml`.

Profil yang masih disebut sebuah agent gak bisa dihapus: agent-nya akan tetap termuat lalu gagal di
pesan pertamanya.

## Default, dan penimpaan per agent

```toml
[llm.defaults]
provider = "nougate-anthropic"
model = "claude-sonnet-4-20250514"
max_tokens = 8192
temperature = 0.7
```

Satu agent menimpa bagian mana pun di pack-nya sendiri:

```toml
# .nouride/agents/nouva/config.toml
[llm]
provider = "nougate-anthropic"
model = "claude-sonnet-4-20250514"
max_tokens = 8192
temperature = 0.7
# context_window = 200000      # hanya kalau Nouride gak tahu jendela model ini
# fallbacks = [                                    # siapa yang menjawab kalau model di atas tidak bisa, berurutan
#   { provider = "nougate", model = "antigravity:gemini-3-flash" },
#   { provider = "ollama-local", model = "qwen3:8b" },
# ]
# effort = "medium"            # berapa lama model yang berpikir menimbang: low, medium, high, xhigh, max
```

Dan satu *percakapan* menimpanya lagi dengan `/model`, yang berlaku untuk chat itu, bukan untuk
agent-nya, dan tetap ada setelah restart sampai `/model default` atau `/reset`.

**`fallbacks` menjawab kalau model agent tidak bisa**: sebuah daftar, masing-masing provider dan model
di provider itu, karena nama model saja tidak berarti apa-apa di provider lain. Setelah retry dari
provider sendiri habis, turn itu ditanyakan ke pasangan berikutnya, berurutan, dan tetap di pasangan yang
menjawab sampai turn itu selesai; baris progres di chat menyebutkannya, dan pemakaiannya dicatat ke
provider itu. Model lain di provider yang sama menjawab rate limit, provider yang kelebihan beban, atau
model yang tidak dilayani; provider lain juga menjawab provider yang mati, kehabisan saldo, atau menolak
kuncinya. Provider dianggap mati kalau tidak bisa dijangkau (koneksinya ditolak, tidak menjawab tepat
waktu, stream yang putus sebelum balasannya mulai), dan cuma provider lain yang menjawabnya. Stream yang
putus sebelum balasannya mulai lebih dulu diminta sekali lagi ke model yang sama, karena belum ada yang
ditampilkan dan belum ada yang dijalankan; fallback menjawab kalau putus lagi. Stream yang putus setelah
balasan mulai tidak diminta ulang dan tidak dialihkan ke fallback: sebagian jawabannya sudah tertulis. Panggilan
yang menutup sebuah turn, balasan yang ditulis saat turn harus berhenti memanggil tool, juga pindah ke
fallback seperti panggilan lain. Request yang ditolak tidak pernah dicoba ulang ke fallback: model mana
pun akan mendapat jawaban yang sama. `[llm.defaults] fallbacks` adalah daftar untuk semua agent yang
tidak menyebut miliknya sendiri, dan tab **Model** agent di dashboard mengubah daftarnya sendiri.
Operator diberi tahu sekali per gangguan, bukan sekali per turn. 0.8.0 menulis ulang `fallback_model` dari 0.7 di setiap pack saat boot
pertamanya menjadi satu pasangan di provider-nya sendiri; pack yang menyebut `fallback_model` lagi ditolak
untuk agent itu, sambil menyebut baris `fallbacks` yang harus ditulis.

**`effort` adalah berapa lama model yang berpikir menimbang sebelum menjawab**: `low`, `medium`, `high`,
`xhigh`, atau `max`; dikirim sebagai `output_config.effort` ke profil Anthropic dan sebagai
`reasoning_effort` ke profil yang kompatibel dengan OpenAI. Kalau tidak diisi, default provider yang
berlaku. Untuk agent chat ini layak diisi: Claude Sonnet 5.5 dengan default-nya berpikir sekitar dua puluh
detik sebelum jawaban pendek, dan selama itu tidak ada yang muncul; dengan `medium` jawaban mulai keluar
dalam sekitar dua detik. `[llm.defaults] effort` berlaku untuk semua agent, dan `[llm] effort` milik agent
sendiri yang menang;
tab **Model** agent di dashboard memilih miliknya sendiri. Nilai di luar lima itu membuat daemon menolak start.
Model yang tidak menerimanya
(yang tidak berpikir, Claude versi lama, atau level yang tidak dikenal endpoint-nya) ditanya ulang tanpa
effort dan sejak itu tidak dikirimi lagi; log mencatatnya sekali. `/effort high` di sebuah chat memasang level chat itu
sendiri di atas milik agent, dan penolakan level itu juga disebut di chat, sekali, di bawah jawabannya.

Agent yang jalan di coding CLI (Claude Code, Codex) mendapat `effort` yang sama, dipasang di CLI-nya kalau CLI itu
menawarkan level tersebut untuk modelnya; kalau tidak, CLI-nya memakai setelannya sendiri. Kamu tidak perlu mengedit
file: pilih di tab **CLI** agent di dashboard, atau minta agent-nya ("pakai xhigh"), dan ia memasangnya sendiri lewat
`agent_configure`, yang minta persetujuan kamu dulu seperti setiap perubahan config-nya, kecuali approval agent itu
`trusted`. **Default** mengikuti `[llm.defaults] effort`.

**Jendela konteks diambil dari gateway kalau ia menyebutkannya, kalau tidak dari id model.** Endpoint
yang daftar `/models`-nya menyebutkan jendela sebuah model (`context_window` milik Nougate,
`context_length` milik OpenRouter, `max_model_len` milik vLLM) dipercaya, dari daftar terakhirnya:
daftar itu ditanyakan saat daemon mulai lalu paling sering sejam sekali, dan tidak ada turn yang
menunggunya. Kalau tidak, id model dicari di tabel keluarga model, prefix dari gateway diabaikan, jadi
`antigravity:claude-sonnet-4-6` dicari sebagai `claude-sonnet-4-6`. Model yang tidak diketahui siapa pun
dianggap punya 32k, dan riwayatnya dipangkas jauh lebih keras dari yang perlu; log menyebutkannya sekali
per model. `context_window` di `[llm]` milik agent itu obatnya, dan mengalahkan keduanya.

Sebuah rute juga bisa menerima lebih sedikit dari yang tertulis di tabel: model yang sama di akun atau paket lain.
Kalau provider menjawab bahwa permintaan melewati jendelanya, turn itu diminta sekali lagi tanpa separuh terlama dari
yang dikirim, dan menjawab dari sisanya. Kalau setiap turn di percakapan panjang kena overflow, jendelanya kebesaran:
tulis jendela rute yang sebenarnya di `context_window`.

**Model versus Models** adalah perbedaan nyata. Profil adalah infrastruktur, didefinisikan sekali dan
dipakai bersama; model adalah pilihan satu agent di dalamnya. Itulah yang membuat satu agent bisa pindah
tanpa menyentuh yang lain.

## Anggaran dan batas

```toml
[llm.limits]
max_tokens_per_turn   = 32000
max_tool_iterations   = 250
max_turn_duration_ms  = 3600000
max_daily_cost_usd    = 0        # 0 = mati
max_daily_tokens      = 0        # 0 = mati
cost_alert_threshold_pct = 80
```

Dua plafon. Keduanya diperiksa sebelum provider dipanggil, dan yang tercapai lebih dulu menolak
giliran itu.

`max_daily_cost_usd` hanya bisa melihat model yang ada di daftar harga: model yang dicantumkan
Anthropic, OpenAI dan Google di halaman harga mereka, berdasarkan id persisnya, dengan harga yang
tertera di halaman itu pada tanggal yang dicatat tiap barisnya. Model yang gak dicantumkan (yang
rilis belakangan, versi preview, model self-hosted) gak punya harga, dan daemon yang diarahkan ke
gateway self-hosted bisa saja gak punya panggilan berharga sama sekali, jadi di situ plafon dolar
bukan ukuran sebagian, tapi gak ada.

Profil provider bisa bilang panggilannya langganan: `billing = "included"`, seperti akun OAuth di
Nougate. Panggilan itu gak ada biaya per token: gak dihitung di `max_daily_cost_usd`, tetap dihitung
di `max_daily_tokens`, dan ditampilkan sebagai termasuk langganan, bukan sebagai pengeluaran harga
daftar.

`max_daily_tokens` menghitung input dan output sekaligus di semua model, berharga atau gak: setiap
panggilan model dicatat (panggilan turn itu sendiri, juga kompaksi, refleksi, pembacaan gambar dan
embedding yang ditimbulkannya), dan provider yang gak melaporkan pemakaian diestimasi, gak pernah
dibaca sebagai nol. Lewat salah satu plafon, kerja yang gak ditunggu siapa pun ikut berhenti.
**Kalau cuma mau set satu, set yang ini.**

Sebelum plafon menghentikan apa pun, operator diberi tahu paling banyak dua kali sehari: sekali lewat
`cost_alert_threshold_pct`, sekali lewat 95%, masing-masing menyebut agent dan model yang paling banyak
memakai hari itu, dan gak diulang setelah restart.

Pemakaian dan biaya dicatat per giliran dan dashboard menampilkan pengeluaran hari ini terhadap
batasnya, memakai angka yang sama dengan yang dipakai penegakannya.

## Konteks: pemadatan, bukan pemotongan

```toml
[llm.context]
max_context_ratio     = 0.8
truncation_strategy   = "summary"     # summary | sliding_window
preserve_recent_turns = 4
compact_at_ratio      = 0.8
# compact_at_tokens   = 160000        # gak diset: tiap model punya angkanya sendiri
preserve_recent_tool_results = 3
# summary_model = "claude-haiku-4-5-20251001"
```

`sliding_window` membuang giliran terlama. Benar untuk muat, salah untuk mengingat: agent yang sudah
sejam mengerjakan sesuatu gak punya catatan apa yang sudah dilakukannya, jadi ia mengulang satu
langkah atau melaporkan sukses untuk langkah yang gak bisa dilihatnya.

`summary`, default-nya, mengganti giliran itu dengan satu catatan padat lalu menyimpannya. Biayanya
satu panggilan provider per pemadatan, bukan per giliran, dan gak terjadi apa pun sampai riwayat
melewati `compact_at_ratio`. Ringkasan yang gagal atau kembali kosong membiarkan riwayatnya utuh dan
pemotongan berjalan persis seperti `sliding_window`, jadi risikonya terbatas pada perilaku lama.

Ringkasannya ditulis oleh `summary_model`, di provider milik agent itu. Kalau gak diisi, ditulis oleh
helper model (`[memory] pass_model`, kartu **Helper model** di Knowledge & Memory → Settings) kalau itu diisi,
kalau tidak oleh model milik agent itu sendiri. Kartu itu juga menunjukkan apakah meringkas gagal dalam
24 jam terakhir.

**`compact_at_tokens` adalah plafon tetap untuk seluruh request, termasuk prompt dan tool, dan ambangnya
adalah yang lebih rendah antara plafon ini dan rasionya.** Kalau gak diset, tiap model punya angkanya
sendiri: 200k untuk Gemini 3 Flash ke atas, 160k untuk sisanya. `[llm] compact_at_tokens` milik agent
mengalahkan keduanya.

Plafon ini ada karena rasio ikut membesar bersama jendela: pada model sejuta token, rasio menempatkan
pemadatan di sekitar 610 ribu, sehingga chat 426 ribu token gak pernah dipadatkan sekali pun dan setiap
iterasi sebuah giliran mengirim ulang semuanya, 12 juta token input untuk satu balasan, dan gilirannya
mati di tenggatnya (waktu itu lima menit) padahal masih maju. Jendela menyatakan apa yang *bisa* dibaca
model; ia gak pernah jadi klaim tentang apa yang sebaiknya dibawa untuk menjawab dengan baik.

`preserve_recent_tool_results` adalah gagasan yang sama di dalam satu giliran. Pemangkasan mengganti
*isinya*; pesannya sendiri selalu tinggal, karena tool call yatim ditolak mentah-mentah oleh Anthropic.
Yang dipangkas gak hilang: output utuhnya ditulis dulu ke direktori `data/tool-output/` percakapan itu
(disimpan selama `[retention] tool_output_days`), dan penandanya menyebut file itu, jadi agent
membukanya dengan `read` alih-alih menjalankan ulang perintahnya.

Begitu sebuah giliran melewati batasnya, hasil lama dibersihkan sekaligus, sampai jauh di bawah batas
itu, dan langkah-langkah berikutnya gak membersihkan apa-apa sampai gilirannya tumbuh lagi. Membersihkan
satu hasil tiap langkah mengubah awal percakapan di setiap langkah, dan cache prompt provider gak
terbaca lagi.

Kalau membersihkan hasil lama belum cukup, teks yang dibawa panggilan `write`, `edit` dan `multi_edit`
lama yang menyusul, dari yang paling lama: panggilannya tetap ada bersama path dan hasilnya, dan
teksnya jadi satu baris yang bilang seberapa besar teks itu, bahwa panggilannya sudah jalan, dan
untuk membaca file-nya kalau perlu isinya sekarang. Panggilan di langkah terakhir gak pernah dipendekkan. Tanpa ini, giliran coding yang
panjang membawa setiap file yang ia tulis sampai jendelanya penuh.

Hasil tool juga diperkecil sesuai jenisnya sebelum masuk percakapan: kode warna terminal dibuang, baris yang
digambar ulang progress bar disisakan keadaan terakhirnya, tiga baris identik atau lebih jadi satu dengan hitungan
`[× N]`, dan JSON kehilangan spasi di antara bagian-bagiannya. Diff dan file yang dibaca dengan `read` dibiarkan
persis. Output utuhnya disimpan dulu di direktori yang sama, dan baris terakhir hasilnya menyebut file itu.

## Prompt caching

System prompt dipecah di tempat **kestabilannya** berubah, lalu ditandai supaya provider bisa men-cache
bagian yang stabil:

| Lapis | Isi | Berubah saat | Di-cache |
|---|---|---|---|
| `files` | identitas, user, agents, skill, memory, apa yang diingat tentang orang-orang di chat itu | pack atau memory itu berubah | ✓ |
| `capability` | blok harness | tool atau sikap exec berubah | ✓ |
| `request` | tanggal, model, platform, siapa yang bicara | harinya, modelnya, atau pengirimnya berubah | ✗ |

Lapis terakhir gak pernah membawa penanda sendiri: itu bagian yang berubah, dan entri cache yang gak
pernah dibaca lagi adalah tambahan biaya 25%, bukan penghematan. Jam sama sekali gak ada di prompt.
Jam ada di pesan yang sedang dijawab, jadi prompt gak berubah antar-request hanya karena waktu berjalan.

Di jalur Anthropic, percakapannya juga dapat penanda, di blok terakhirnya, dan penanda itu maju di
setiap request. Panggilan tool kedua puluh dalam satu giliran lalu membaca semuanya sampai yang
kesembilan belas dari cache, dan hanya menulis apa yang ditambahkan sejak itu.

**Urutannya menopang, terlepas dari penandanya**, karena prefix cache implisit, satu-satunya yang
dimiliki jalur OpenAI, berhenti cocok pada byte pertama yang berbeda. Menaruh harness sebelum blok
per-request menaikkan prefix yang layak di-cache dari 5,0 ribu token menjadi ~8,0 ribu di setiap
permintaan dan di setiap iterasi tool dalam satu giliran.

## Streaming

```toml
[llm.streaming]
enabled = true               # mengakumulasi stream; balasan parsial gak dikirim
typing_indicator = true
progress_in_chat = true
```

`progress_in_chat` memposting **satu** pesan yang menyebut tool yang sedang dijalankan agent, menyuntingnya
seiring giliran berjalan, dan menggantinya di akhir dengan `✓ 4 steps · 12s`, di platform yang bisa
menyunting pesan. Satu pesan dan bukan satu per langkah, karena menyunting gak memberi notifikasi ulang:
giliran dengan dua puluh tool akan jadi dua puluh notifikasi di HP. Giliran yang gak menjalankan tool
gak memposting apa pun.

Saklar yang sama juga mengatur **kalimat pembuka** agent, di semua platform, termasuk yang gak bisa
menyunting pesan (WhatsApp). Kalau model menulis satu kalimat di samping panggilan tool pertamanya ("Oke
Kak, aku cek 52 dokumennya dulu ya"), kalimat itu langsung dikirim ke chat sebagai pesan tersendiri,
gak menunggu giliran selesai. Kalimat berikutnya baru dikirim kalau sudah lewat dua menit sejak yang
terakhir, jadi kerja panjang dapat kabar sesekali, bukan komentar tiap langkah; sisanya tetap tersimpan
di percakapan. Jawaban akhir gak mengulangnya. Pertanyaan yang dijawab tanpa tool tetap satu pesan, dan
giliran dari background job atau jadwal gak mengirim kalimat pembuka.

Agent yang dijawab coding CLI (Claude Code, Codex) gak kena aturan dua menit itu: apa yang ditulis CLI di
sela langkahnya langsung masuk ke chat begitu ditulis, masing-masing pesan sendiri, seperti di
terminalnya sendiri. Tiap kali itu terjadi, pesan progres sejauh ini ditutup jadi `✓ 3 steps · 20s` dan
langkah sesudahnya mulai di pesan baru di bawahnya. Pesan yang kamu kirim selagi dia bekerja dapat
jawabannya sendiri, sebelum jawaban berikutnya dimulai.

## Konkurensi

```toml
[queue]
max_concurrent_per_agent = 1     # per chat. Loader menolak angka lebih tinggi
max_concurrent_turns     = 8     # untuk semua percakapan. 0 mencabut plafonnya
max_queue_depth          = 20
queue_timeout_ms         = 3600000
```

Konkurensi per chat dipatok 1 dan itu bukan keputusan penyetelan: percakapan disimpan sebagai satu
dokumen JSON, jadi dua giliran sekaligus di satu chat akan sama-sama membacanya dan sama-sama menulis
ulang seluruhnya. Yang lebih lambat menang dan pertukaran satunya hilang dari transkrip tanpa tercatat
apa pun. Chat yang berbeda sudah berjalan paralel tanpa pengaturan apa pun.

`max_concurrent_turns` adalah totalnya. Tanpanya, lima puluh chat aktif berarti lima puluh panggilan
provider bersamaan, lima puluh kali pengeluaran per detik, dan rate limit provider langsung kena. Helper
`delegate` milik sebuah agent dan agent yang ditanyainya lewat `ask_agent` juga dihitung: mereka memakai
slot milik giliran itu sendiri, dan slot lain hanya kalau ada yang kosong. Di daemon yang sibuk mereka
berjalan bergantian, bukan sekaligus. Helper dan permintaan yang lanjut di latar belakang dibatasi
`[delegate] max_background`.

`queue_timeout_ms` disamakan dengan `max_turn_duration_ms`, bukan dipilih sendiri: pesan yang mengantre
di belakang sebuah giliran harus hidup lebih lama dari giliran itu, atau satu balasan lambat diam-diam
memakan pesan berikutnya. Loader memperingatkan kalau angka ini yang lebih pendek.

## Kalau provider gagal

Request yang gagal karena hal yang bisa beres dengan menunggu dicoba lagi selama sekitar setengah
menit: rate limit (429), overload, 5xx, timeout, koneksi putus. Itu enam percobaan, berjarak 1, 2, 4,
8 dan 16 detik. Jeda yang disebut provider (`Retry-After` atau `retry-after-ms`) dituruti kalau lebih
panjang, paling lama semenit. Provider yang minta lebih lama dari itu biasanya kehabisan kuota, dan
menunggu cuma akan menahan chat-nya, jadi request-nya langsung gagal.

Provider yang sama sekali gak menjawab dicoba dua kali, bukan enam, karena tiap percobaan bisa makan
dua menit. Dua menit itu batas sampai provider mulai menjawab: balasan yang sudah mulai mengalir boleh
selama yang ia perlukan, dan baru diputus kalau diam satu setengah menit. Stream yang putus sebelum
ada balasannya sama sekali diminta sekali lagi ke model yang sama. `/stop` atau shutdown selama
menunggu langsung menghentikan giliran, dan `base_url` yang bukan URL valid langsung gagal: itu soal
konfigurasi, bukan gangguan jaringan.

Kalau provider-nya mati lebih lama dari itu, gilirannya berakhir, menyimpan apa yang sudah dikerjakan,
dan bilang begitu:

> …I'll try again in a few minutes, or say "continue".

Sekitar tiga menit kemudian, ditambah sampai semenit supaya chat-chat yang gagal bareng gak dicoba
serentak, daemon mencoba giliran itu sekali lagi dan melanjutkan dari tempat ia berhenti. Itu gak
terjadi kalau ada yang bilang sesuatu di chat itu sejak gagal, untuk run terjadwal, untuk giliran yang
justru percobaan kedua, atau untuk kegagalan yang gak beres dengan menunggu: key kedaluwarsa atau
ditolak, saldo habis, request yang salah. Yang seperti itu harus kamu bereskan sendiri. Restart dalam
beberapa menit itu gak membatalkannya: daemon yang kembali menemukan giliran itu dari apa yang ia
bilang ke kamu, dan mencobanya sekali, waktu beberapa menit itu habis. "Continue" juga tetap jalan.
