#!/usr/bin/env bun
/**
 * Copy `scripts/install.sh` and `scripts/install-bundle-router.sh` into this site's `public/`, so
 * `get.nouride.com/install.sh` and `get.nouride.com/install-bundle-router.sh` serve the installers
 * this repository actually maintains.
 */

import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "../../..");
const PUBLIC = join(HERE, "../public");

await mkdir(PUBLIC, { recursive: true });

async function syncScript(sourcePath: string, targetName: string) {
  const source = await stat(sourcePath).catch(() => null);
  if (!source) {
    console.error(`✗ ${sourcePath} is missing`);
    process.exit(1);
  }

  const target = join(PUBLIC, targetName);
  await copyFile(sourcePath, target);
  console.log(`✓ ${targetName} synced to apps/site/public/${targetName} (${(source.size / 1024).toFixed(1)} KB)`);
}

await syncScript(join(ROOT, "scripts/install.sh"), "install.sh");
await syncScript(join(ROOT, "scripts/install-bundle-router.sh"), "install-bundle-router.sh");
