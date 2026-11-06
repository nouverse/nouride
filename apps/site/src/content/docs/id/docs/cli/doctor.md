---
title: doctor
description: Satu perintah yang memeriksa hal-hal yang benar-benar menghentikan instalasi baru.
---

```bash
nouride doctor
```

Setiap temuan menyebutkan apa yang harus dilakukan, dan perintah ini **keluar dengan kode bukan nol
kalau ada masalah nyata**, jadi ia bekerja di dalam healthcheck atau langkah CI, bukan hanya di depan
manusia.

## Apa yang diperiksanya, berurutan

Urutannya disengaja. Bagian yang bekerja tanpa daemon berjalan lebih dulu, karena config yang cukup
rusak biasanya justru sebabnya gak ada yang berjalan.

**Dari disk, ada daemon atau gak**

1. **Config mana yang dimuat**, dan direktori data mana. Dua baris, dan itu cara tercepat menyadari
   bahwa CLI menemukan instalasi yang beda dari yang kamu maksud.
2. **Config itu sendiri**: setiap lint yang dikenal `nouride config check`, beserta petunjuknya.
3. **SQLite di dalam binary ini**, dan apakah ia punya FTS5, yang dibutuhkan indeks memori. Build tanpa
   FTS5 menolak start; semua binary rilis punya.
4. **Paket sistem**: nyala dan dengan package manager apa, mati, atau gak dipakai di sini. Mati itu
   pilihan, jadi disebutkan saja, bukan diperingatkan.
5. **Apa yang sudah dipasang para agent.** Lihat [baris-baris toolchain](#baris-baris-toolchain).
6. **Unit systemd**, kalau ada. Unit dari sebelum 0.7 membunuh perintah yang sedang dijalankan sebuah
   giliran di awal restart, alih-alih membiarkan giliran itu menyelesaikan langkahnya. Jalankan ulang
   `install.sh` sekali; `.nouride/` gak disentuh.

**Dari daemon**

7. **Bisakah ia mencapai daemon?** Semua di bawah ini bergantung padanya, jadi kegagalan di sini
   melaporkan satu baris yang akurat alih-alih dinding akibat, lalu berhenti. Kalau bisa, baris
   berikutnya adalah memori daemon itu sendiri, yang resident dan heap JavaScript yang terpakai, seperti
   yang dilaporkan `/health` (sejak 0.7.11): disebut, bukan dinilai.
8. **Pemeriksaan integritas indeks memori.** Indeks itu cache dari vault, jadi perbaikannya
   `nouride memory reindex`, bukan restore.
9. **Giliran yang tahan crash**: berapa giliran yang sedang jalan dan berapa pesan yang menunggu.
10. **Provider yang punya kredensial.** Gak ada satu pun adalah kegagalan keras, gak ada agent yang
    bisa menjawab. Satu profil tanpa kredensial adalah peringatan.
11. **Agent pack yang gagal dimuat**, beserta error parse-nya.
12. **Agent yang benar-benar berjalan.** Gak ada adalah kegagalan keras, dan petunjuknya membedakan
    "gak ada yang dibuat" dari "termuat tapi dinonaktifkan".
13. **Workspace root yang dideklarasikan tapi gak ada.** Inilah pemeriksaan yang absen ketika satu
    kelas kebingungan terjadi: semua hal lain hijau, agent jalan, gateway tersambung, provider punya
    kredensial, sementara setiap path di dalam root itu ditolak, yang terbaca seolah agent-nya rusak.
14. **Agent yang menunjuk provider tanpa key**, atau yang gak terkonfigurasi sama sekali. Inilah
    kegagalan yang terlihat seperti gangguan model.
15. **Gateway**, satu baris per gateway. Yang berstatus `dead` adalah kegagalan, dengan perintah
    restart di petunjuknya; status lain selain `connected` adalah peringatan, begitu juga kalau gak
    ada gateway sama sekali.
16. **Approval yang menunggu**, karena sebuah tool call tertahan sampai dijawab.
17. **Pesan yang mengantre**, karena giliran mungkin menumpuk.
18. **Skill yang software host-nya gak ada.** Peringatan kalau ada agent yang menyalakannya;
    sekadar dicatat kalau gak ada.
19. **Skill yang dibawa agent tapi tak bisa dijalankannya**: sumbu tool, per agent, hanya menyebut apa
    yang benar-benar kurang untuk agent itu.
20. **Skill yang belum ada catatan dibacanya**, dilaporkan sebagai wajar, bukan sebagai kesalahan.

## Baris-baris toolchain

Agent memasang program tanpa root, ke `.nouride/bin`. Baris-baris ini dibaca dari disk, jadi tetap
menjawab saat daemon mati. Siapa memasang apa ada di `nouride audit`; ini keadaannya.

- **Apa yang ada**: setiap program di `.nouride/bin`, ke mana tiap link menunjuk, dan mana yang
  ditemukan lebih dulu daripada program sistem dengan nama yang sama.
- **Link ke dalam cache** adalah peringatan: membersihkan cache itu, yang pasti dilakukan siapa pun
  yang kehabisan disk, merusak programnya tanpa ada yang bilang kenapa. **Link yang putus** adalah
  kegagalan yang sama setelah terjadi.
- **Program yang menutupi program yang diandalkan semua agent**, seperti `git`, `tar`, `python3`,
  `node` atau sebuah shell, adalah peringatan. Direktori bin ada paling depan di `PATH` setiap
  perintah, jadi salinan itulah yang dijalankan semua agent.
- **`package.json`, `package-lock.json` atau `node_modules` di `.nouride/`** berarti seseorang
  menjalankan `npm install` di situ, bukan instalasi global. Gak ada yang membacanya.

Kalau `HOME` para agent adalah `.nouride/home`, yang diberikan unit service dan container, ada tiga
lagi:

- **Ke mana instalasi mendarat**: instalasi global `npm`, `bun`, `pipx`, `uv`, `go` dan `cargo` masuk
  ke `.nouride/bin`, yang disiapkan daemon saat start.
- **Python env bersama**, `.nouride/opt/python`: itulah `python3` dan `pip` bagi para agent, plus apa
  kata `pip check` tentangnya. Semua agent memasang ke env yang sama, jadi upgrade dari satu agent bisa
  merusak paket untuk semuanya; petunjuknya bilang cara mengembalikannya. Requirement yang kata
  `pip check` tidak terpasang tapi bisa di-import Python, misalnya modul dari paket OS yang tidak membawa
  metadata pip, tidak dihitung rusak. Kalau belum dibangun,
  `pip install` akan kena PEP 668. Daemon membangunnya saat start, dan log-nya bilang kenapa gagal,
  biasanya karena paket `python3-venv` belum ada.
- **Pemakaian disk** `bin`, `lib` dan `opt` serta cache para installer di `home`, jadi disk yang penuh
  punya tempat pertama untuk dicek.

Di Linux, satu lagi: `/usr/local/bin/nouride` **berupa link** ke binary instalasi berarti root yang
menjalankan `nouride` menjalankan file yang bisa diubah service account. Sejak 0.7, `install.sh`
menaruh launcher di situ, yang menjalankan CLI sebagai service account. Jalankan ulang sekali.

## Bentuk keluarannya

Satu run di instalasi service, dipersingkat:

```
nouride doctor

  ✓ config: /srv/nouride/.nouride/config.toml
  ✓ data dir: /srv/nouride/.nouride/data
  ✓ sqlite: 3.51.0, with FTS5
  ✓ system packages: off, so agents install into their own bin directory (install.sh --allow-packages turns it on)
  ✓ agents' programs in /srv/nouride/.nouride/bin: ffprobe → /srv/nouride/.nouride/home/.bun/install/cache/ffprobe, gh
  ! agents' programs: ffprobe is a link into a cache (/srv/nouride/.nouride/home/.bun/install/cache/ffprobe): clearing that cache breaks it
    Reinstall it properly, or remove it: rm /srv/nouride/.nouride/bin/ffprobe
  ✓ daemon reachable at http://localhost:@@PORT@@ (up 3120s)
  ✓ daemon memory: 72.8MB resident, 8.7MB of it JavaScript heap in use
  ✓ memory index: FTS5 integrity check passed
  ✓ providers with credentials: nougate-anthropic
  ✓ agents running: nouva, nox
  ! nouva: workspace root /home/kamu/projects/thing does not exist
    Nothing in it can be read. Check [workspace] roots in agents/nouva/config.toml. A leading ~ expands to your home directory, and a relative path resolves against the agent's own folder.
  ✓ gateway web:dashboard: connected
  ✓ gateway telegram:nouva: connected
  ✗ gateway discord:main is dead
    Check its token, then `nouride gateway restart <id>`.

1 problem(s), 2 warning(s)
```

`✓` berarti baik, `!` layak diketahui, `✗` yang benar-benar rusak. Hanya `✗` yang memengaruhi exit code.

## Bentuk lama

Dari 0.7.11 sampai 0.7.28 laporannya diakhiri bagian "Ready for 0.8.0" yang mendaftar tiap bentuk lama yang
masih dipakai instalasi ini. 0.8.0 hanya start di atas data yang sudah dijalankan 0.7.28, dan menolak tiap bentuk
itu di tempat ia dibaca (daemon untuk `config.toml`, agent itu untuk pack) sambil menyebut apa yang harus ditulis;
[Update](/id/docs/deployment/updating/#dari-versi-yang-lebih-lama) mendaftarnya. Jadi bagian itu sudah tidak ada.

## Dua temuan yang layak dijelaskan

**"skill X needs `dot`, not installed here".** Sebuah skill menyatakan program yang dibutuhkannya di
frontmatter-nya, dan itulah yang membuat hal ini bisa diperiksa sama sekali. Tanpa pemeriksaan itu,
kegagalannya tak terlihat sampai menjadi mahal: skill-nya termuat, agent membacanya, mengikuti
prosedurnya, dan langkah empat mati dengan `dot: command not found`: di tengah tugas, dengan satu
approval sudah terpakai.

**"N of M skills have no read on record".** Setiap skill memakan satu baris di system
prompt *setiap* agent pada *setiap* giliran, dibaca atau gak, terukur ~3,4 KB untuk delapan belas
skill di sebuah mesin live. Jadi skill yang belum pernah dibuka adalah tagihan yang gak dipilih siapa
pun.

Catatannya menyimpan setiap kali skill dibaca sejak 0.7.27, selama apa pun, dan gak ikut terhapus
oleh `[retention] audit_days` audit log. Bacaan sebelum itu cuma diketahui sejauh yang masih ada di
audit log saat upgrade (default-nya 30 hari), jadi yang bisa dikatakan dengan jujur adalah "belum ada
catatan dibaca", bukan "gak pernah dibaca".

## Kalau ia gak bisa mencapai daemon

Ia berhenti di situ dan mengatakannya, dengan semua yang bisa dicek dari disk sudah tercetak di layar.
Path config dan direktori data biasanya sudah jadi jawabannya. Tiga kasus memberi tahu lebih banyak:

- **Gak ada control token** di tempat yang dicari CLI: doctor cuma mencetak itu, dengan path yang
  diharapkannya. Entah daemon belum pernah start di situ, atau CLI menemukan instalasi yang beda dari
  yang sedang jalan.
- **Permission denied** pada token: token itu milik service account, dan doctor cuma mencetak itu.
  Jalankan `sudo nouride doctor`, atau masukkan dirimu ke grup service-nya.
- **Daemon instalasi lain** yang menjawab di port yang sama disebut apa adanya: semua instalasi
  memakai port default yang sama, jadi yang start duluan yang dapat.

## Terkait

```bash
nouride config check [file]     # apakah konfigurasi ini akan start? Tidak ada yang dijalankan
nouride status                  # agent, gateway, antrean
nouride update                  # versi, edisi, direktori instalasi dan supervisor; gak mengubah apa pun
```
