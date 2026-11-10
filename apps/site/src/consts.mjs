/**
 * Every value the site says out loud that is not prose.
 *
 * Download URLs, the port, the image name, the release channel, each of them appears on a dozen
 * pages in two languages, and each of them is the kind of thing that gets changed once and missed
 * in eleven places. They live here, and pages reach them through the `@@TOKEN@@` substitution in
 * `plugins/remark-consts.mjs` (Markdown and MDX) or by importing this file (MDX and `.astro`).
 *
 * Plain `.mjs` rather than `.ts` on purpose: `astro.config.mjs` and the remark plugin both load it
 * outside Vite, where a TypeScript import does not resolve.
 */

/** The domain the binary and its installer are served from. */
export const DOWNLOAD_DOMAIN = 'get.nouride.com';

/** Path of the installer on that domain. */
export const INSTALL_SCRIPT_PATH = 'install.sh';

/** Release channel a bare download resolves to. A tag like `v0.1.0` works in its place. */
export const RELEASE_CHANNEL = 'latest';

export const DOWNLOAD_BASE_URL = `https://${DOWNLOAD_DOMAIN}`;

/** `https://get.nouride.com/install.sh`: the one URL the front page asks anyone to run. */
export const INSTALL_SCRIPT_URL = `${DOWNLOAD_BASE_URL}/${INSTALL_SCRIPT_PATH}`;

/** Root the installer downloads tarballs from. */
export const TARBALL_BASE_URL = `${DOWNLOAD_BASE_URL}/${RELEASE_CHANNEL}`;

/**
 * Linux wants root, it creates a service account and a systemd unit. Piping to `sh` rather than
 * `bash` because the script is POSIX sh and Alpine has no bash.
 */
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_SCRIPT_URL} | sudo sh`;

/** A Mac installs as the user who will run it: a LaunchAgent, no root, so no `sudo`. */
export const MAC_INSTALL_COMMAND = `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`;

/** Read it before running it. Printed next to the command everywhere the command appears. */
export const INSPECT_COMMAND = `curl -fsSL ${INSTALL_SCRIPT_URL} | less`;

/** The published build targets: the four Linux ones and darwin-arm64. */
export const TARGETS = [
  { id: 'linux-x64', os: 'Linux', arch: 'x86_64', libc: 'glibc', note: 'Debian, Ubuntu, RHEL, Arch' },
  { id: 'linux-arm64', os: 'Linux', arch: 'aarch64', libc: 'glibc', note: 'Raspberry Pi OS 64-bit, Ubuntu arm64, Armbian' },
  { id: 'linux-x64-musl', os: 'Linux', arch: 'x86_64', libc: 'musl', note: 'Alpine, also needs `apk add libstdc++`' },
  { id: 'linux-arm64-musl', os: 'Linux', arch: 'aarch64', libc: 'musl', note: 'Alpine on ARM, also needs `apk add libstdc++`' },
  { id: 'darwin-arm64', os: 'macOS', arch: 'Apple Silicon', libc: 'Mach-O', note: 'M1 and later' },
];

/** Download URL for one target on the current channel. */
export const tarballUrl = (target, channel = RELEASE_CHANNEL) =>
  `${DOWNLOAD_BASE_URL}/${channel}/nouride-${target}.tar.gz`;

export const SITE_URL = 'https://nouride.com';

/** Nouride Cloud managed platform URL */
export const CLOUD_URL = 'https://app.nouverse.tech/pod/products/nouride';

/** The community: the Discord server, linked from the landing page's footer and from the dashboard's Settings. */
export const COMMUNITY_URL = 'https://discord.gg/egh2hBj6v';

/** Where Pro is asked about until it is sold as a licence: an email to Nouverse. */
export const PRO_CONTACT = 'mailto:contact@nouverse.tech?subject=Nouride%20Pro';

/** Where the container image is published from `.github/workflows/release.yml`. */
export const DOCKER_IMAGE = 'ghcr.io/nouverse/nouride';

/** The repository the installer falls back to when `--repo` is passed. */
export const GITHUB_REPO = 'nouverse/nouride';

/** One port serves the health endpoint, the dashboard and the control API. */
export const DEFAULT_PORT = 18254;
export const DASHBOARD_URL = `http://127.0.0.1:${DEFAULT_PORT}/dashboard/`;
export const HEALTH_URL = `http://127.0.0.1:${DEFAULT_PORT}/health`;

/**
 * The container in one line, for the front page: the latest image, its port, and its data in `./nouride`. The docs'
 * Docker page has the compose file and the longer form.
 */
export const DOCKER_RUN_COMMAND = `docker run -d --name nouride --restart unless-stopped -p ${DEFAULT_PORT}:${DEFAULT_PORT} -v "$PWD/nouride:/app/.nouride" ${DOCKER_IMAGE}`;

/** Default install directory the Linux installer creates. */
export const INSTALL_DIR = '/srv/nouride';

export const VERSION = '0.8.30';

/** Umami Cloud Analytics */
export const UMAMI_WEBSITE_ID = 'cffbb7be-1ec9-4a59-9466-f7ead9c732ac';
export const UMAMI_SCRIPT_URL = 'https://cloud.umami.is/script.js';

/** The `@@TOKEN@@` table the remark plugin substitutes. Order does not matter; keys are exact. */
export const TOKENS = {
  DOWNLOAD_DOMAIN,
  DOWNLOAD_BASE: DOWNLOAD_BASE_URL,
  INSTALL_URL: INSTALL_SCRIPT_URL,
  INSTALL_CMD: INSTALL_COMMAND,
  INSPECT_CMD: INSPECT_COMMAND,
  TARBALL_BASE: TARBALL_BASE_URL,
  SITE_URL,
  CLOUD_URL,
  DOCKER_IMAGE,
  GITHUB_REPO,
  PORT: String(DEFAULT_PORT),
  DASHBOARD_URL,
  HEALTH_URL,
  INSTALL_DIR,
  VERSION,
};
