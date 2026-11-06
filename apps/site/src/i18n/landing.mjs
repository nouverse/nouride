/**
 * The landing page, in words.
 *
 * Separated from the markup because the page is one component rendered twice, not two pages. Markup
 * and CSS live once in `components/Landing.astro`; only the sentences differ.
 */

/** @typedef {typeof en} LandingCopy */

export const en = {
  meta: {
    title: 'Nouride - Multi AI Agent Runtime for Edge Devices',
    description:
      'Full-capability autonomous agent engine for Raspberry Pi, Orange Pi, and any Linux SBCs. Automate tasks, control home devices, and coordinate multi-agent workflows 24/7 on mini-hardware.',
  },
  nav: { docs: 'Docs', install: 'Install', cloud: 'Cloud', github: 'GitHub' },
  hero: {
    eyebrow: '⚡ Multi AI Agent Runtime for Edge Devices',
    title: 'Multi AI Agent Runtime for Edge Devices',
    tagline:
      'Full-capability autonomous agent engine for Raspberry Pi, Orange Pi, and any Linux SBCs. Automate tasks, control home devices, and coordinate multi-agent workflows 24/7 on mini-hardware.',
    hardwareBadge: 'Raspberry Pi · Orange Pi · Rockchip · Any 64-bit Linux SBC · ~40MB download · runs in 64 MB of RAM (measured 2026-10-17)',
    installLabel: 'One command, on Linux, macOS or Docker:',
    platforms: { linux: 'Linux', macos: 'macOS', docker: 'Docker' },
    inspectNote: 'Want to inspect the script first? Read it before running:',
    dockerNote: 'Your agents and settings stay in ./nouride, beside where you ran it. The compose file and every option:',
    dockerGuide: 'Docker guide',
    primary: 'Get Started',
    secondary: 'Learn More',
    copy: 'Copy',
    copied: 'Copied!',
  },
  what: {
    title: 'Why Nouride?',
    lead: 'A standalone runtime running locally on your hardware.',
    cards: [
      {
        title: 'Built for Raspberry Pi, Orange Pi, and any Linux SBCs',
        body:
          'Engineered for constrained single-board computers (Raspberry Pi, Orange Pi, Rockchip, Radxa, and 64-bit Linux SBCs). Ships as one standalone binary (a ~40MB download), runs in 64 MB of RAM from its very first start (measured 2026-10-17), no GPU required, and runs cool 24/7.',
      },
      {
        title: 'Independent multi-agent roster',
        body:
          'Every agent has its own identity, LLM profile, tools, and memory stored in human-readable Markdown and TOML. Agents can collaborate and hand off tasks directly.',
      },
      {
        title: 'Answers where you already chat',
        body:
          'Native adapters for Telegram, Discord, and WhatsApp, plus a web dashboard and interactive terminal CLI. Same agent, same memory, wherever you message.',
      },
      {
        title: 'Asks before running dangerous commands',
        body:
          'Risky commands pause for your approval right inside the chat. Recursive deletes, stopping services, tearing down infrastructure, and credential paths are never auto-approved behind your back.',
      },
    ],
  },
  showcase: {
    title: 'Visual web dashboard',
    lead: 'Manage providers, watch live execution turns, review tool approvals, and chat with your agents. Served directly by the daemon, zero extra services to deploy.',
    shots: [
      { src: '/media/dashboard-overview.png', alt: 'The dashboard overview' },
      { src: '/media/dashboard-chat.png', alt: 'A conversation with live turn steps' },
      { src: '/media/dashboard-approvals.png', alt: 'The approval queue' },
      { src: '/media/dashboard-schedule.png', alt: 'Scheduled work' },
    ],
  },
  steps: {
    title: 'Up and running in 5 minutes',
    items: [
      { title: '1. Run the installer', body: 'The script sets up a dedicated system service, installs the daemon beside its dashboard, and starts it in the background.', link: 'docs/start/install' },
      { title: '2. Grab your setup password', body: 'A one-time admin password is generated on first start and printed directly to the service journal log.', link: 'docs/start/first-run' },
      { title: '3. Finish setup in your browser', body: 'Connect your model endpoint (Anthropic, OpenAI, local Ollama, etc.), name your first agent, and craft their persona.', link: 'docs/start/first-run' },
      { title: '4. Hook up your chat apps', body: 'Paste your Telegram or Discord bot token, or scan a WhatsApp QR code. Your assistant is ready to help.', link: 'docs/start/connect-chat' },
    ],
    cta: 'Read the Complete Installation Guide',
  },
  numbers: {
    title: 'Real benchmarks, zero fluff',
    lead: 'Measured directly on physical edge hardware, no marketing exaggerations.',
    items: [
      { value: '64 MB', label: 'RAM floor, first start included', note: 'Measured 2026-10-17 on linux-arm64. Comfortable on Raspberry Pi, Orange Pi & SBCs' },
      { value: '~40 MB', label: 'Download size', note: 'Standalone single binary with embedded runtime, compressed' },
      { value: '0.7%', label: 'CPU idle (of 1 core)', note: 'Uses just 0.7% of a single core while waiting for events' },
      { value: '0', label: 'External database dependencies', note: 'No Postgres, Redis, or vector database required' },
    ],
    source: 'Full system requirements & test measurements',
    sourceLink: 'docs/architecture/performance',
  },
  where: {
    title: 'Where your agents live',
    items: ['Telegram', 'Discord', 'WhatsApp', 'Web Dashboard', 'Terminal CLI'],
    note: 'Running multiple bots on the same platform is supported out of the box, one agent per token, each with its own identity and role.',
  },
  footer: {
    title: 'Take control of your own AI agents',
    body: 'One command to install, then configure everything in a browser tab. The manual covers everything from daily workflows to custom skills.',
    primary: 'Install Nouride',
    secondary: 'Browse the Docs',
    github: 'GitHub',
  },
};

/** @type {LandingCopy} */
export const id = {
  meta: {
    title: 'Nouride - Runtime Multi AI Agent untuk Edge Device',
    description:
      'Engine AI agent otonom berkemampuan penuh untuk Raspberry Pi, Orange Pi, dan Linux SBC apa pun. Otomasi tugas, kontrol perangkat rumah, dan koordinasikan alur kerja multi-agent 24/7 di mini-hardware.',
  },
  nav: { docs: 'Dokumentasi', install: 'Instalasi', cloud: 'Cloud', github: 'GitHub' },
  hero: {
    eyebrow: '⚡ Runtime Multi AI Agent untuk Edge Device',
    title: 'Runtime Multi AI Agent untuk Edge Device',
    tagline:
      'Engine AI agent otonom berkemampuan penuh untuk Raspberry Pi, Orange Pi, dan Linux SBC apa pun. Otomasi tugas, kontrol perangkat rumah, dan koordinasikan alur kerja multi-agent 24/7 di mini-hardware.',
    hardwareBadge: 'Raspberry Pi · Orange Pi · Rockchip · Linux SBC 64-bit apapun · Unduhan ~40MB · jalan di RAM 64 MB (diukur 2026-10-17)',
    installLabel: 'Satu perintah, di Linux, macOS, atau Docker:',
    platforms: { linux: 'Linux', macos: 'macOS', docker: 'Docker' },
    inspectNote: 'Mau cek isi script-nya dulu sebelum dijalankan? Ketik:',
    dockerNote: 'Agent dan pengaturan tersimpan di ./nouride, di folder tempat kamu menjalankannya. File compose dan semua opsinya:',
    dockerGuide: 'panduan Docker',
    primary: 'Mulai Sekarang',
    secondary: 'Pelajari Dulu',
    copy: 'Salin',
    copied: 'Tersalin!',
  },
  what: {
    title: 'Kenapa pakai Nouride?',
    lead: 'Runtime mandiri yang jalan langsung di hardware kamu.',
    cards: [
      {
        title: 'Dibuat untuk Raspberry Pi, Orange Pi, dan Linux SBC lainnya',
        body:
          'Dirancang khusus untuk single-board computer (Raspberry Pi, Orange Pi, Rockchip, Radxa, dan berbagai Linux SBC). Cukup satu binary mandiri (unduhan ~40MB), jalan di RAM 64 MB sejak start pertamanya (diukur 2026-10-17), tanpa butuh GPU, dan aman untuk MicroSD.',
      },
      {
        title: 'Banyak agent dengan persona terisolasi',
        body:
          'Tiap agent punya kepribadian, model, memori, dan tool sendiri yang disimpan rapi dalam format Markdown & TOML. Agent juga bisa saling mendelegasikan task secara otomatis.',
      },
      {
        title: 'Hadir di chat yang kamu pakai tiap hari',
        body:
          'Akses agent kamu lewat Telegram, Discord, WhatsApp, sampai terminal CLI. Mau chat dari mana pun, agent tetap punya memori yang sama.',
      },
      {
        title: 'Aman dengan konfirmasi manusia (Approval Gate)',
        body:
          'Perintah berisiko bakal nunggu izin dari kamu langsung di chat. Hapus rekursif, mematikan layanan, membongkar infrastruktur, dan path kredensial tidak pernah di-approve otomatis di belakang kamu.',
      },
    ],
  },
  showcase: {
    title: 'Web Dashboard yang interaktif',
    lead: 'Pantau log aktivitas real-time, beri persetujuan tool (approval), atur jadwal kerja otomatis, dan ngobrol langsung lewat browser. Semuanya disajikan langsung oleh daemon.',
    shots: [
      { src: '/media/dashboard-overview.png', alt: 'Overview dashboard' },
      { src: '/media/dashboard-chat.png', alt: 'Percakapan interaktif dengan step eksekusi' },
      { src: '/media/dashboard-approvals.png', alt: 'Antrean approval tool' },
      { src: '/media/dashboard-schedule.png', alt: 'Jadwal kerja berkala' },
    ],
  },
  steps: {
    title: 'Cuma 5 menit, langsung siap pakai',
    items: [
      { title: '1. Jalankan script installer', body: 'Script otomatis download binary yang pas, pasang service systemd, dan menyalakan daemon di background.', link: 'docs/start/install' },
      { title: '2. Ambil password pertama', body: 'Cek log service buat ambil password sementara yang di-generate pas pertama kali daemon nyala.', link: 'docs/start/first-run' },
      { title: '3. Setup via Web Dashboard', body: 'Buka browser, masukkan API key model favorit kamu (Anthropic, OpenAI, dll), lalu racik nama dan persona agent pertama kamu.', link: 'docs/start/first-run' },
      { title: '4. Sambungkan ke platform chat', body: 'Cukup tempel token bot Discord/Telegram atau scan QR WhatsApp. Agent kamu langsung aktif dan siap diajak kerja.', link: 'docs/start/connect-chat' },
    ],
    cta: 'Lihat Panduan Instalasi Lengkap',
  },
  numbers: {
    title: 'Diukur langsung, anti-omong kosong',
    lead: 'Semua angka di bawah diukur langsung di hardware edge fisik, bukan estimasi di atas kertas.',
    items: [
      { value: '64 MB', label: 'Batas bawah RAM, start pertama juga', note: 'Diukur 2026-10-17 di linux-arm64. Lega di Raspberry Pi, Orange Pi & SBC' },
      { value: '~40 MB', label: 'Ukuran unduhan', note: 'Single binary mandiri dengan runtime terintegrasi, terkompresi' },
      { value: '0.7%', label: 'CPU idle (dari 1 core)', note: 'Hanya menggunakan 0.7% dari 1 core saat menunggu pesan masuk' },
      { value: '0', label: 'Layanan dependensi luar', note: 'Tanpa butuh Postgres, Redis, atau vector database tambahan' },
    ],
    source: 'Spesifikasi sistem lengkap & hasil pengukuran',
    sourceLink: 'docs/architecture/performance',
  },
  where: {
    title: 'Platform chat yang didukung',
    items: ['Telegram', 'Discord', 'WhatsApp', 'Web Dashboard', 'Terminal CLI'],
    note: 'Bisa pasang beberapa bot sekaligus di platform yang sama, satu agent per bot token, masing-masing dengan kepribadian dan tugas yang beda.',
  },
  footer: {
    title: 'Mulai bangun AI workspace kamu sendiri',
    body: 'Jalankan satu perintah instalasi, buka browser, dan kelola asisten AI kamu secara mandiri.',
    primary: 'Pasang Sekarang',
    secondary: 'Baca Dokumentasi',
    github: 'GitHub',
  },
};
