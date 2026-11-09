/**
 * The landing page, in words.
 *
 * Separated from the markup because the page is one component rendered twice, not two pages. Markup
 * and CSS live once in `components/Landing.astro`; only the sentences differ.
 *
 * Every claim here is one the docs make, and says where: a number keeps the date it was measured on. The product's own
 * words inside a drawn fragment of it (a button, the line an approval opens with) stay as the product shows them, in
 * English on both pages; what a person would have typed into it is translated.
 */

/** @typedef {typeof en} LandingCopy */

export const en = {
  meta: {
    title: 'Nouride: AI agents that live on your box',
    description:
      'Nouride runs a few AI agents on a small box you own, and uses very little of it. Chat with them on Telegram, Discord, WhatsApp or in your browser.',
  },
  nav: { docs: 'Docs', pro: 'Pro', github: 'GitHub', other: 'Bahasa Indonesia', otherShort: 'ID', otherLang: 'id', install: 'Install' },
  hero: {
    lines: ['AI agents that live', 'on your box'],
    tagline:
      'Nouride runs a few AI agents on a small box you own, and uses very little of it. Chat with them on Telegram, Discord, WhatsApp or right in your browser.',
    primary: 'Install Nouride',
    secondary: 'What is it?',
    mascotAlt: 'The Nouride cat, waving hello',
    /** The folder tabs, back to front. Each one names a chapter below and lends it its colour. */
    folders: { office: 'Office', approvals: 'Approvals', missions: 'Missions', chats: 'Chats', start: 'Start here' },
    pick: 'Where will it live?',
    platforms: { linux: 'Linux', macos: 'Mac', docker: 'Docker', android: 'Android' },
    notes: {
      linux: 'A Raspberry Pi, an Orange Pi, a mini PC or any 64-bit Linux. It sets itself up as a service.',
      inspect: 'Read the script first:',
      macos: 'A Mac with Apple Silicon. No sudo: it runs as you, while you are logged in.',
      docker: 'Your agents and settings stay in ./nouride, beside where you ran it.',
      dockerGuide: 'Docker guide',
      android:
        'Nouride Home runs Nouride on a 64-bit Android phone, with no terminal and no root. Install the app and press Start.',
      androidGet: 'Get Nouride Home',
      androidGuide: 'How it works',
    },
    copy: 'Copy',
    copied: 'Copied',
  },
  chats: {
    title: 'Say hi from the apps you already use',
    places: ['Telegram', 'Discord', 'WhatsApp', 'Your browser'],
    note: 'Same agent, same memory, wherever you write. Each agent can have a bot of its own, with its own name.',
    link: 'Connect a chat app',
    mascotAlt: 'The Nouride cat on its scooter, delivering a parcel',
  },
  missions: {
    title: 'Give it a goal, go to bed',
    agent: 'Pip',
    goal: 'Sort out the family photo backup',
    now: 'sorting the 2019 folder',
    question: 'Keep the blurry ones, or delete them?',
    clauses: [
      'First it writes a plan, then waits for you.',
      'You say go. A restart will not stop it.',
      'Stuck? It asks you one clear question.',
      'Done means every check passed.',
    ],
    link: 'How missions work',
    mascotAlt: 'The Nouride cat at its laptop, working',
  },
  approvals: {
    title: 'Risky stuff waits for your yes',
    tiles: {
      prompt: ['It stops and asks', 'Mid-task, in the chat where you asked. Nothing runs while it waits.'],
      anywhere: ['Answer from anywhere', 'In the chat or on the dashboard: it is one queue.'],
      keys: ['Tap it or type it', 'Buttons on Telegram and Discord, commands everywhere.'],
      always: ['Always, for one command', 'Stops asking for that exact command.'],
      fixed: ['Some things always ask', 'Deleting for good, stopping Nouride, a password leaving the box: no "always" for these.'],
      timeout: ['Silence is a no', 'A question left for five minutes expires, and expiring is a no.'],
      restart: ['A restart is not a yes', 'A question still open is asked again once Nouride is back.'],
    },
    link: 'Approvals and permissions',
    mascotAlt: 'The Nouride cat, pointing at what needs you',
  },
  office: {
    title: 'Peek into the Office',
    body:
      'Each agent is a pixel cat in a little office. It sits at its desk while it works, puts a hand up when it needs you, sits on the sofa when there is nothing to do, and goes to bed when it is asleep. Click a cat to see what it is up to.',
    legend: ['At its desk: working', 'Hand up: waiting for you', 'On the sofa: idle', 'In bed: asleep'],
    shot: { src: '/media/dashboard-office.png', alt: 'The Office in the dashboard: cats at their desks, on the sofa and in bed' },
    actions: { office: 'How the Office works', dashboard: 'Tour the dashboard' },
  },
  learn: {
    lines: ['They learn,', 'and they remember'],
    table: 'What they keep',
    rows: [
      { kind: 'Skills', text: 'They write down what they worked out. You decide what they keep.', link: 'docs/manual/skills' },
      { kind: 'Memory', text: "With memory on, each day's chats are filed at night: a summary, and facts about the people in them.", link: 'docs/architecture/memory' },
      { kind: 'Knowledge', text: 'Your manuals, price lists and notes. Answers say which document they came from.', link: 'docs/manual/knowledge' },
      { kind: 'Schedule', text: 'Reminders and jobs that run on time, every day or just once.', link: 'docs/manual/schedule' },
      { kind: 'Teamwork', text: 'An agent can hand a job to another agent, or to a helper in the background.' },
      { kind: 'Coding', text: 'Claude Code and Codex can join as agents of their own.', link: 'docs/manual/external-agents' },
      { kind: 'Tools', text: 'Files, the web, commands and MCP servers, switched on per agent.', link: 'docs/architecture/tools' },
      { kind: 'Persona', text: 'Each agent is a folder of plain Markdown: its name, its manner, its rules.', link: 'docs/architecture/agents' },
    ],
    mascotAlt: 'The Nouride cat, reading a book',
  },
  footprint: {
    claim: 'Happy on a tiny box',
    figure: '64',
    unit: 'MB',
    caption: 'of RAM is its floor, first start included (measured 2026-10-17, linux-arm64). No GPU, no database server.',
    source: 'How it was measured',
  },
  editions: {
    title: 'Editions',
    community: {
      name: 'Community',
      for: 'Everything on this page, for your own box.',
      body:
        'One account with a password. The Router build adds the Nougate gateway, so your agents can use an AI subscription you already have.',
      price: 'Free',
      action: 'Install',
    },
    pro: {
      name: 'Pro',
      for: 'For a family or a team.',
      body: 'Adds accounts for several people, Sign in with Nouverse, and pairing with a Nouride Box.',
      action: 'See Pro',
    },
  },
  close: {
    sentence: 'One command, then three short steps in your browser.',
    word: 'Install',
    /** The word's width in em, in Fredoka at the band's tracking, so it can be sized to fill the band. */
    fit: 2.45,
    descends: false,
  },
  footer: {
    what: 'Nouride, by',
    links: { docs: 'Docs', github: 'GitHub', home: 'Nouride Home' },
  },
};

/** @type {LandingCopy} */
export const id = {
  meta: {
    title: 'Nouride: agent AI yang tinggal di mesinmu',
    description:
      'Nouride menjalankan beberapa agent AI di box kecil milikmu, dan cuma butuh sedikit resource. Ngobrol dengan mereka lewat Telegram, Discord, WhatsApp, atau browser.',
  },
  nav: { docs: 'Dokumentasi', pro: 'Pro', github: 'GitHub', other: 'English', otherShort: 'EN', otherLang: 'en', install: 'Pasang' },
  hero: {
    lines: ['Agent AI yang', 'tinggal di mesinmu'],
    tagline:
      'Nouride menjalankan beberapa agent AI di box kecil milikmu, dan cuma butuh sedikit resource. Ajak mereka ngobrol lewat Telegram, Discord, WhatsApp, atau langsung di browser.',
    primary: 'Pasang Nouride',
    secondary: 'Kenalan dulu',
    mascotAlt: 'Kucing Nouride melambaikan tangan',
    folders: { office: 'Office', approvals: 'Izin', missions: 'Misi', chats: 'Chat', start: 'Mulai di sini' },
    pick: 'Mau dipasang di mana?',
    platforms: { linux: 'Linux', macos: 'Mac', docker: 'Docker', android: 'Android' },
    notes: {
      linux: 'Raspberry Pi, Orange Pi, mini PC, atau Linux 64-bit apa pun. Dia langsung terpasang sebagai service.',
      inspect: 'Mau baca script-nya dulu?',
      macos: 'Mac dengan Apple Silicon. Tanpa sudo: jalan sebagai akunmu, selama kamu login.',
      docker: 'Agent dan pengaturanmu tersimpan di ./nouride, di folder tempat kamu menjalankannya.',
      dockerGuide: 'Panduan Docker',
      android:
        'Nouride Home menjalankan Nouride di HP Android 64-bit, tanpa terminal dan tanpa root. Pasang aplikasinya, lalu tekan Start.',
      androidGet: 'Unduh Nouride Home',
      androidGuide: 'Cara kerjanya',
    },
    copy: 'Salin',
    copied: 'Tersalin',
  },
  chats: {
    title: 'Sapa dari aplikasi yang biasa kamu pakai',
    places: ['Telegram', 'Discord', 'WhatsApp', 'Browser'],
    note: 'Agent yang sama, ingatan yang sama, dari mana pun kamu chat. Tiap agent bisa punya bot sendiri, lengkap dengan namanya.',
    link: 'Sambungkan aplikasi chat',
    mascotAlt: 'Kucing Nouride naik skuter, mengantar paket',
  },
  missions: {
    title: 'Kasih tujuan, tinggal tidur',
    agent: 'Pip',
    goal: 'Rapikan backup foto keluarga',
    now: 'memilah folder 2019',
    question: 'Foto yang buram disimpan atau dihapus?',
    clauses: [
      'Dia tulis rencananya, lalu menunggumu.',
      'Kamu bilang gas. Restart pun lanjut.',
      'Mentok? Dia tanya satu hal yang jelas.',
      'Selesai berarti semua cek lolos.',
    ],
    link: 'Cara kerja misi',
    mascotAlt: 'Kucing Nouride di depan laptop, sedang bekerja',
  },
  approvals: {
    title: 'Yang berisiko, nunggu izinmu',
    tiles: {
      prompt: ['Dia berhenti dan bertanya', 'Di tengah kerja, di chat tempat kamu meminta. Tidak ada yang jalan selama dia menunggu.'],
      anywhere: ['Jawab dari mana saja', 'Dari chat atau dashboard: antreannya satu.'],
      keys: ['Tekan atau ketik', 'Tombol di Telegram dan Discord, perintah di mana saja.'],
      always: ['Selalu, untuk satu perintah', 'Berhenti bertanya untuk perintah yang persis sama.'],
      fixed: ['Yang ini selalu tanya', 'Hapus permanen, mematikan Nouride, password keluar dari mesin: tidak ada "selalu" untuk ini.'],
      timeout: ['Diam berarti tidak', 'Pertanyaan yang dibiarkan lima menit akan kedaluwarsa, dan kedaluwarsa berarti tidak.'],
      restart: ['Restart bukan berarti ya', 'Pertanyaan yang masih terbuka ditanyakan lagi begitu Nouride menyala.'],
    },
    link: 'Approval dan izin',
    mascotAlt: 'Kucing Nouride menunjuk yang butuh kamu',
  },
  office: {
    title: 'Intip Office-nya',
    body:
      'Tiap agent jadi kucing pixel di kantor kecil. Dia duduk di mejanya saat bekerja, angkat tangan saat butuh kamu, duduk di sofa saat tidak ada kerjaan, dan tidur di kasur saat istirahat. Klik kucingnya untuk lihat dia lagi ngapain.',
    legend: ['Di meja: bekerja', 'Angkat tangan: menunggu kamu', 'Di sofa: santai', 'Di kasur: tidur'],
    shot: { src: '/media/dashboard-office.png', alt: 'Office di dashboard: kucing di meja, di sofa, dan di kasur' },
    actions: { office: 'Cara kerja Office', dashboard: 'Keliling dashboard' },
  },
  learn: {
    lines: ['Mereka belajar,', 'dan mereka ingat'],
    table: 'Yang mereka simpan',
    rows: [
      { kind: 'Skill', text: 'Mereka mencatat cara yang berhasil. Kamu yang putuskan mana yang disimpan.', link: 'docs/manual/skills' },
      { kind: 'Memori', text: 'Kalau memori aktif, chat tiap hari dirangkum tiap malam: ringkasan, plus fakta tentang orang-orangnya.', link: 'docs/architecture/memory' },
      { kind: 'Knowledge', text: 'Manual, daftar harga, dan catatanmu. Jawabannya menyebut dokumen sumbernya.', link: 'docs/manual/knowledge' },
      { kind: 'Jadwal', text: 'Pengingat dan tugas yang jalan tepat waktu, tiap hari atau sekali saja.', link: 'docs/manual/schedule' },
      { kind: 'Kerja tim', text: 'Agent bisa mengoper tugas ke agent lain, atau ke helper di background.' },
      { kind: 'Coding', text: 'Claude Code dan Codex bisa ikut jadi agent sendiri.', link: 'docs/manual/external-agents' },
      { kind: 'Tool', text: 'File, web, perintah, dan server MCP, dinyalakan per agent.', link: 'docs/architecture/tools' },
      { kind: 'Persona', text: 'Tiap agent adalah folder Markdown biasa: namanya, gayanya, aturannya.', link: 'docs/architecture/agents' },
    ],
    mascotAlt: 'Kucing Nouride sedang membaca buku',
  },
  footprint: {
    claim: 'Betah di mesin mungil',
    figure: '64',
    unit: 'MB',
    caption: 'RAM adalah batas bawahnya, start pertama juga (diukur 2026-10-17, linux-arm64). Tanpa GPU, tanpa server database.',
    source: 'Cara mengukurnya',
  },
  editions: {
    title: 'Edisi',
    community: {
      name: 'Community',
      for: 'Semua yang ada di halaman ini, untuk mesinmu sendiri.',
      body:
        'Satu akun dengan password. Versi Router menambahkan gateway Nougate, jadi agent bisa pakai langganan AI yang sudah kamu punya.',
      price: 'Gratis',
      action: 'Pasang',
    },
    pro: {
      name: 'Pro',
      for: 'Untuk keluarga atau tim.',
      body: 'Menambahkan akun untuk beberapa orang, Masuk dengan Nouverse, dan pairing dengan Nouride Box.',
      action: 'Lihat Pro',
    },
  },
  close: {
    sentence: 'Satu perintah, lalu tiga langkah singkat di browser.',
    word: 'Pasang',
    fit: 3.1,
    /** The word has a descender (the g), which the band makes room for. */
    descends: true,
  },
  footer: {
    what: 'Nouride, dari',
    links: { docs: 'Dokumentasi', github: 'GitHub', home: 'Nouride Home' },
  },
};
