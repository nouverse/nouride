---
title: Office
description: Status agent-agent kamu dalam bentuk kantor kecil berisi kucing (siapa yang kerja, siapa yang nunggu kamu, siapa yang santai atau tidur), dan tampilan sendiri untuk tiap agent.
---

**Agents → Office** menampilkan apa yang sedang dikerjakan agent-agent kamu sebagai kantor kecil pixel art: ruang
kerja, lobi, dan kamar tidur, berjejer di atas lorong. Tiap agent adalah kucing Nouride dengan meja sendiri, kursi
sofa sendiri, dan kasur sendiri (meja orchestrator sendirian di depan ruang kerja, dengan mahkota di namanya).
Home menampilkan agent yang sama di **Your agents**: kucing tiap agent, namanya, dan apa yang sedang ia kerjakan.

![Office: Nouva, sang orchestrator, dan Ember sedang kerja (Ember dengan tanda ! merah karena gak bisa kerja), Wren nunggu kamu, Kira dan Pip di sofa, Moss tidur, dan Codey di kasur karena gak bisa kerja](/media/dashboard-office.png)

## Di mana kucingnya

Tiap kucing ada di tempat yang sesuai status agent-nya. Kalau lebih dari satu berlaku, yang paling atas di tabel ini
yang dipakai.

| Status | Di mana | Di atasnya | Kapan |
|---|---|---|---|
| Nunggu kamu | Di mejanya, angkat tangan | `?` | Ada approval, atau pertanyaan dari turn-nya, yang nunggu jawaban orang; atau salah satu misinya butuh kamu: pertanyaan yang harus dijawab, macet, kena batas, atau hasilnya nunggu di-accept. |
| Kerja | Di mejanya, di balik laptop | `…` | Ada yang jalan: turn di chat, job di latar, perintah yang ditinggal jalan di latar oleh CLI coding-nya (Claude Code, Codex), atau misi yang sedang dikerjakan, termasuk di jeda antar turn misi itu dan saat ia mencoba model-nya lagi sendiri. |
| Tidur | Di kasurnya | `z` | Kamu menidurkannya, atau ia gak bisa kerja (lihat di bawah), dan gak ada yang jalan. |
| Santai | Di kursinya, di lobi | gak ada | Bangun, gak ada yang jalan. |

**Agent yang gak bisa kerja** tidur sampai ia bisa: pack yang gagal dimuat atau dimatikan, model tanpa kredensial, CLI
coding yang belum terpasang atau belum login. Label dan kartunya bilang kenapa, misalnya "Codey, asleep, cannot work:
Codex is not signed in". Kalau ia masih kerja atau nunggu kamu saat jadi gak bisa kerja (key dihapus di tengah tugas,
CLI-nya logout), ia tetap di mejanya dengan tanda **`!`** merah di atasnya, lalu pindah ke kasur begitu itu selesai.

Kalau status berubah, kucingnya jalan ke tempat barunya
lewat pintu dan lorong, namanya ikut jalan. Di HP ruangannya tersusun atas-bawah, lorongnya di sebelah kiri.
Jendelanya menunjukkan langit sesuai jam di tempatmu, siang atau malam.

Satu office muat dua belas agent: orchestrator selalu ada, lalu yang paling dulu dibuat. Kalau lebih, sisanya ada di
office lain (pintu di ujung lorong menyebut berapa), dan baris di atas office menghitung semuanya, termasuk berapa
dari yang di office lain sedang nunggu kamu.

Klik kucing untuk lihat agent-nya lagi ngapain dan di mana, dengan link ke tiap chat dan misi, lalu tidurkan atau
bangunkan, buka chat-nya, atau ganti tampilannya.

Halaman ini menanyakan status agent tiap lima detik selama terbuka dan terlihat, dan gak menanyakan apa-apa kalau
tidak. Gak ada yang bergerak kalau sistem kamu minta gerakan dikurangi, dan di HP kantornya mengecil supaya muat.

## Tampilan tiap agent

Halaman tiap agent punya tab **Look** dengan kucingnya digambar seperti nanti. Pilih bagian mana pun; bagian yang
kamu biarkan diambil dari id agent itu, jadi agent yang gak pernah diatur tetap punya tampilan yang sama, dan gak ada
dua agent kembar dalam satu kantor.

| Bagian | Key | Kata |
|---|---|---|
| Fur | `fur` | ginger, grey, black, white, brown, cream |
| Pattern | `pattern` | plain, tabby |
| Outfit | `outfit` | none, hoodie, tee, jacket |
| Outfit colour | `outfit_color` | blue, lime, peach, charcoal, sage, lilac, white; topi dan syal ikut warna ini; white hanya kalau dipilih |
| Hat | `hat` | none, beanie, cap, beret, headband, headphones |
| Accessory | `accessory` | none, glasses, sunglasses, scarf |
| Eyes | `eyes` | round, sleepy, sparkly |

Tampilan disimpan di `[look]` dalam `config.toml` agent itu, jadi ikut terbawa bersama pack-nya:

```toml
[look]
fur = "black"
outfit = "hoodie"
outfit_color = "lime"
hat = "beanie"
```

Kata yang bukan salah satu kata bagiannya bikin agent itu gagal dimuat, dan error-nya menyebut kata apa saja yang
diterima bagian itu; agent lain tetap dimuat. Kalau di-rollback ke 0.8.0, yang belum punya Office, `[look]` agent
diabaikan dengan peringatan soal key yang gak dikenal, lalu dibaca lagi begitu 0.8.1 balik.
