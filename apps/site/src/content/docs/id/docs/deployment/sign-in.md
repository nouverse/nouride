---
title: Masuk dengan Nouverse
description: Edisi self-hosted masuk dengan password lokal; masuk dengan Nouverse hanya ada di edisi Pro.
---

Edisi self-hosted, Community dan Router, masuk ke dashboard dengan password lokal, dan CLI menjangkau
daemon dengan control token yang disimpan di `.nouride/data`. Gak ada urusan login yang keluar dari
mesin kamu.

Integrasi **OAuth (Sign in with Nouverse)** gak ada di keduanya: alurnya gak ikut dikompilasi, dan menyetel `NOURIDE_OAUTH_ISSUER` membuat daemon menolak boot, bukan mengabaikannya. Fitur ini hanya ada di edisi Pro.

Kalau kamu menjalankan Nouride secara mandiri, pengelolaan akses sepenuhnya ada di tangan kamu: akun lokal di dashboard, siapa yang boleh ngobrol dengan agent (`nouride access`), dan approval tool (`nouride approvals`, atau dashboard).
