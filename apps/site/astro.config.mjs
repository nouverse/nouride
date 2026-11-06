import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import { remarkConsts } from './src/plugins/remark-consts.mjs';
import { GITHUB_REPO, SITE_URL, UMAMI_SCRIPT_URL, UMAMI_WEBSITE_ID } from './src/consts.mjs';

/**
 * The brand assets, which live once in `packages/shared/assets` and are used by every surface.
 *
 * An alias rather than a `@nouride/shared` dependency: these are files, not modules, so Astro hashes
 * them into this site's own output and none of the package's code follows. The dashboard resolves
 * `@brand` the same way — see its `vite.config.ts` for why the dependency edge is not worth a logo.
 */
const brand = fileURLToPath(new URL('../../packages/shared/assets', import.meta.url));

/**
 * One entry per page, in the order it is meant to be read.
 *
 * The order is the argument. Somebody arriving here has downloaded a binary and wants a working
 * assistant; the architecture is what they read afterwards, if at all. So the first two groups are
 * the install and the manual, and nothing in them assumes a checkout, a terminal beyond one command,
 * or that the reader knows what a persona pack is.
 */
const sidebar = [
  {
    label: 'Start Here',
    translations: { id: 'Mulai di Sini' },
    items: [
      { label: 'What is Nouride?', slug: 'docs/start/what-is-nouride', translations: { id: 'Apa itu Nouride?' } },
      { label: 'Install', slug: 'docs/start/install', translations: { id: 'Instalasi' } },
      { label: 'First run', slug: 'docs/start/first-run', translations: { id: 'Menyalakan Pertama Kali' } },
      { label: 'Connect a chat app', slug: 'docs/start/connect-chat', translations: { id: 'Menyambungkan Aplikasi Chat' } },
      { label: 'When it does not work', slug: 'docs/start/troubleshooting', translations: { id: 'Kalau Belum Jalan' } },
    ],
  },
  {
    label: 'Manual',
    translations: { id: 'Panduan Pemakaian' },
    items: [
      { label: 'Day to day', slug: 'docs/manual/overview', translations: { id: 'Pemakaian Sehari-hari' } },
      { label: 'The dashboard', slug: 'docs/manual/dashboard', translations: { id: 'Dashboard' } },
      { label: 'Talking to an agent', slug: 'docs/manual/chatting', translations: { id: 'Mengobrol dengan Agent' } },
      { label: 'Knowledge base', slug: 'docs/manual/knowledge', translations: { id: 'Knowledge Base' } },
      { label: 'Approvals & permissions', slug: 'docs/manual/approvals', translations: { id: 'Approval & Izin' } },
      { label: 'Skills & learning', slug: 'docs/manual/skills', translations: { id: 'Skill & Pembelajaran' } },
      { label: 'Who may talk to it', slug: 'docs/manual/access', translations: { id: 'Siapa yang Boleh Bicara' } },
      { label: 'Scheduled work', slug: 'docs/manual/schedule', translations: { id: 'Tugas Terjadwal' } },
      { label: 'Missions', slug: 'docs/manual/missions', translations: { id: 'Misi' } },
      { label: 'External agents', slug: 'docs/manual/external-agents', translations: { id: 'Agent Eksternal' } },
      { label: 'Office', slug: 'docs/manual/office', translations: { id: 'Office' } },
      { label: 'Backup, upgrade, uninstall', slug: 'docs/manual/maintenance', translations: { id: 'Backup, Upgrade, Uninstall' } },
    ],
  },
  {
    label: 'Architecture',
    translations: { id: 'Arsitektur' },
    items: [
      { label: 'Overview & design', slug: 'docs/architecture/overview', translations: { id: 'Ikhtisar & Desain' } },
      { label: 'Agents & persona packs', slug: 'docs/architecture/agents', translations: { id: 'Agent & Persona Pack' } },
      { label: 'Tools, sandbox & policy', slug: 'docs/architecture/tools', translations: { id: 'Tool, Sandbox & Policy' } },
      { label: 'State & storage', slug: 'docs/architecture/storage', translations: { id: 'State & Penyimpanan' } },
      { label: 'Memory', slug: 'docs/architecture/memory', translations: { id: 'Memori' } },
      { label: 'Footprint & performance', slug: 'docs/architecture/performance', translations: { id: 'Konsumsi Sumber Daya' } },
    ],
  },
  {
    label: 'Gateways',
    translations: { id: 'Gateway' },
    items: [
      { label: 'Overview', slug: 'docs/gateways/overview', translations: { id: 'Ikhtisar' } },
      { label: 'Telegram', slug: 'docs/gateways/telegram' },
      { label: 'Discord', slug: 'docs/gateways/discord' },
      { label: 'WhatsApp', slug: 'docs/gateways/whatsapp' },
      { label: 'Terminal chat', slug: 'docs/gateways/cli-chat', translations: { id: 'Chat lewat Terminal' } },
    ],
  },
  {
    label: 'Models & providers',
    translations: { id: 'Model & Provider' },
    items: [
      { label: 'Provider profiles', slug: 'docs/providers/configuration', translations: { id: 'Profil Provider' } },
      { label: 'Nougate gateway', slug: 'docs/providers/nougate', translations: { id: 'Gateway Nougate' } },
    ],
  },
  {
    label: 'CLI',
    items: [
      { label: 'Command reference', slug: 'docs/cli/reference', translations: { id: 'Referensi Perintah' } },
      { label: 'doctor', slug: 'docs/cli/doctor' },
      { label: 'Cron & webhooks', slug: 'docs/cli/cron', translations: { id: 'Cron & Webhook' } },
    ],
  },
  {
    label: 'Deployment',
    translations: { id: 'Deployment' },
    items: [
      { label: 'Builds & downloads', slug: 'docs/deployment/binaries', translations: { id: 'Build & Unduhan' } },
      { label: 'Server & systemd', slug: 'docs/deployment/production', translations: { id: 'Server & Systemd' } },
      { label: 'System packages', slug: 'docs/deployment/system-packages', translations: { id: 'Paket sistem' } },
      { label: 'Docker & Compose', slug: 'docs/deployment/docker' },
      { label: 'Homelab & mini PCs', slug: 'docs/deployment/homelab', translations: { id: 'Homelab & Mini PC' } },
      { label: 'An Android phone as a server', slug: 'docs/deployment/android-server', translations: { id: 'HP Android Jadi Server' } },
      { label: 'Sign in with Nouverse', slug: 'docs/deployment/sign-in', translations: { id: 'Masuk dengan Nouverse' } },
      { label: 'Updating', slug: 'docs/deployment/updating', translations: { id: 'Memperbarui' } },
      { label: 'Upgrading to 0.8', slug: 'docs/deployment/upgrading-to-0-8', translations: { id: 'Upgrade ke 0.8' } },
    ],
  },
  {
    label: 'Reference',
    translations: { id: 'Referensi' },
    items: [
      { label: 'Configuration', slug: 'docs/reference/config', translations: { id: 'Konfigurasi' } },
      { label: 'Environment variables', slug: 'docs/reference/environment', translations: { id: 'Environment Variable' } },
      { label: 'FAQ', slug: 'docs/reference/faq' },
    ],
  },
];

/**
 * `/docs/manual/dashboard` → `/en/docs/manual/dashboard`, one entry per page.
 *
 * Enumerated rather than written as `'/docs/[...slug]'`, which a static build refuses: Astro cannot
 * pre-render a spread it has no way to expand, and asks for a `getStaticPaths` that a redirect has
 * no place to put. Derived from the sidebar so the two cannot disagree — a page added there gets its
 * languageless alias for free, and one removed loses it.
 */
const languageless = Object.fromEntries(
  sidebar
    .flatMap((group) => group.items)
    .map((item) => [`/${item.slug}`, `/en/${item.slug}`]),
);

export default defineConfig({
  site: SITE_URL,
  vite: {
    resolve: {
      alias: { '@brand': brand },
    },
  },
  markdown: {
    processor: unified({
      remarkPlugins: [remarkConsts],
    }),
  },
  /**
   * Every URL on this site starts with a language, and one that does not is sent to English.
   *
   * One rule for the whole site rather than a special case for the front page, because the second
   * shape people type is `nouride.com/docs/...` — it is what the sidebar's own breadcrumbs read
   * like and what anybody shortens a link to. Without the second entry that is a 404 on the most
   * guessable path there is.
   *
   * Locale first (`/en/docs/...`) and not `/docs/en/...`: Starlight derives its routes as
   * `/<locale>/<slug>`, so this is the shape the integration produces rather than one fought for,
   * and it keeps the rule above true of every page including the landing ones.
   */
  redirects: {
    '/cloud': 'https://app.nouverse.tech/pod/products/nouride',
    '/docs': '/en/docs/start/what-is-nouride',
    ...languageless,
  },
  integrations: [
    starlight({
      title: 'Nouride',
      favicon: '/favicon.png',
      social: [
        { icon: 'github', label: 'GitHub', href: `https://github.com/${GITHUB_REPO}` },
      ],
      head: [
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.googleapis.com',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.gstatic.com',
            crossorigin: 'anonymous',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Manrope:wght@300;400;500;600;700;800&display=swap',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: `${SITE_URL}/og.png`,
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:secure_url',
            content: `${SITE_URL}/og.png`,
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:width',
            content: '1200',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:height',
            content: '630',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:image:type',
            content: 'image/png',
          },
        },
        {
          tag: 'meta',
          attrs: {
            property: 'og:site_name',
            content: 'Nouride',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:card',
            content: 'summary_large_image',
          },
        },
        {
          tag: 'meta',
          attrs: {
            name: 'twitter:image',
            content: `${SITE_URL}/og.png`,
          },
        },
        {
          tag: 'script',
          attrs: {
            defer: true,
            src: UMAMI_SCRIPT_URL,
            'data-website-id': UMAMI_WEBSITE_ID,
          },
        },
        {
          tag: 'script',
          attrs: {
            defer: true,
            src: '/analytics.js',
          },
        },
      ],
      defaultLocale: 'en',
      locales: {
        en: { label: 'English', lang: 'en' },
        id: { label: 'Bahasa Indonesia', lang: 'id' },
      },
      logo: {
        src: '@brand/nouride.png',
      },
      customCss: ['./src/styles/custom.css'],
      components: {
        Footer: './src/components/DocsFooter.astro',
      },
      // Every page in both languages, so a reader who switches locale mid-way lands on the same
      // page rather than back at the index.
      sidebar,
    }),
  ],
});
