#!/usr/bin/env bun
/**
 * Generate 1200x630 Open Graph banner for social previews (WhatsApp, Twitter/X, Discord, LinkedIn).
 * Clean, grounded developer aesthetic — solid colors, crisp typography, no tacky gradients.
 */

import sharp from "sharp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");
const MASCOT_PATH = join(ROOT, "packages/shared/assets/nouride-chibi.png");
const OUTPUT_PATH = join(__dirname, "../public/og.png");

// Transparent background avoids black letterboxing borders when fitting aspect ratios
const mascotBuffer = await sharp(MASCOT_PATH)
  .resize(460, 460, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer();

const mascotBase64 = `data:image/png;base64,${mascotBuffer.toString("base64")}`;

const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="grid" width="36" height="36" patternUnits="userSpaceOnUse">
      <path d="M 36 0 L 0 0 0 36" fill="none" stroke="rgba(255, 255, 255, 0.03)" stroke-width="1"/>
    </pattern>
  </defs>

  <!-- Deep solid dark background (Linear / Raycast / GitHub dark aesthetic) -->
  <rect width="1200" height="630" fill="#0b0f17" />
  <rect width="1200" height="630" fill="url(#grid)" />

  <!-- Outer frame border with subtle contrast -->
  <rect x="24" y="24" width="1152" height="582" rx="20" fill="none" stroke="rgba(255, 255, 255, 0.08)" stroke-width="1.5" />
  
  <!-- Left Side: Content -->
  <!-- Top Category Badge: Built for Raspberry Pi and any Linux SBCs -->
  <g transform="translate(68, 68)">
    <rect x="0" y="0" width="365" height="34" rx="17" fill="#131b28" stroke="rgba(255, 255, 255, 0.12)" stroke-width="1" />
    <path transform="translate(14, 9) scale(0.65)" d="M7 2v11h3v9l7-12h-4l4-8z" fill="#38bdf8" />
    <text x="36" y="22" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="13" font-weight="600" fill="#cbd5e1" letter-spacing="0.2">Built for Raspberry Pi and any Linux SBCs</text>
  </g>

  <!-- Brand Name: Solid Crisp White, No Gradient -->
  <text x="68" y="195" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="82" font-weight="800" fill="#ffffff" letter-spacing="-2">Nouride</text>

  <!-- Tagline: Solid Slate Blue / Off-white, No Gradient -->
  <text x="68" y="248" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="32" font-weight="600" fill="#94a3b8" letter-spacing="-0.5">Serious Agents. Tiny Runtime.</text>

  <!-- Description paragraph: Solid Muted Slate -->
  <text x="68" y="302" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="19" font-weight="400" fill="#64748b">
    <tspan x="68" dy="0">Self-hosted autonomous AI engine running on your own hardware.</tspan>
    <tspan x="68" dy="28">Native Telegram, Discord and WhatsApp. One daemon, runs in 64 MB.</tspan>
  </text>

  <!-- Feature Pills with Vector SVG Icons -->
  <g transform="translate(68, 395)">
    <!-- Pill 1: the measured floor -->
    <g transform="translate(0, 0)">
      <rect x="0" y="0" width="168" height="42" rx="10" fill="#131b28" stroke="rgba(255, 255, 255, 0.08)" stroke-width="1"/>
      <path transform="translate(13, 12) scale(0.75)" d="M7 2v11h3v9l7-12h-4l4-8z" fill="#38bdf8"/>
      <text x="36" y="26" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="14" font-weight="500" fill="#e2e8f0">64 MB floor</text>
    </g>

    <!-- Pill 2: Raspberry Pi & SBCs -->
    <g transform="translate(180, 0)">
      <rect x="0" y="0" width="202" height="42" rx="10" fill="#131b28" stroke="rgba(255, 255, 255, 0.08)" stroke-width="1"/>
      <g transform="translate(14, 12) scale(0.75)">
        <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="#38bdf8" stroke-width="2"/>
        <rect x="7" y="7" width="10" height="10" rx="1" fill="#38bdf8"/>
        <path d="M1 9h2 M1 15h2 M21 9h2 M21 15h2 M9 1v2 M15 1v2 M9 21v2 M15 21v2" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>
      </g>
      <text x="40" y="26" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="14" font-weight="500" fill="#e2e8f0">Raspberry Pi &amp; SBCs</text>
    </g>

    <!-- Pill 3: Zero External DBs -->
    <g transform="translate(394, 0)">
      <rect x="0" y="0" width="195" height="42" rx="10" fill="#131b28" stroke="rgba(255, 255, 255, 0.08)" stroke-width="1"/>
      <g transform="translate(14, 12) scale(0.75)">
        <ellipse cx="12" cy="5" rx="9" ry="3" fill="none" stroke="#38bdf8" stroke-width="2"/>
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" fill="none" stroke="#38bdf8" stroke-width="2"/>
        <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" fill="none" stroke="#38bdf8" stroke-width="2"/>
      </g>
      <text x="39" y="26" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="14" font-weight="500" fill="#e2e8f0">Zero External DBs</text>
    </g>
  </g>

  <!-- Channels row: Minimal solid styling -->
  <g transform="translate(68, 452)">
    <rect x="0" y="0" width="395" height="38" rx="8" fill="#111622" stroke="rgba(255, 255, 255, 0.06)" stroke-width="1"/>
    <g transform="translate(12, 11) scale(0.68)">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
    <text x="36" y="24" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="13.5" font-weight="500" fill="#94a3b8">Telegram · Discord · WhatsApp · Web Dashboard</text>
  </g>

  <!-- Footer domain link -->
  <g transform="translate(68, 535)">
    <circle cx="6" cy="6" r="4" fill="#10b981" />
    <text x="20" y="10" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="15" font-weight="600" fill="#475569" letter-spacing="0.5">nouride.com</text>
    <text x="140" y="10" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="12" font-weight="400" fill="#475569">64 MB floor measured 2026-10-17, linux-arm64, a first start included</text>
  </g>

  <!-- Right Side: Clean Mascot (No tacky gradient glow) -->
  <g transform="translate(680, 85)">
    <image href="${mascotBase64}" x="0" y="0" width="460" height="460" />
  </g>
</svg>
`;

await sharp(Buffer.from(svg))
  .png({ quality: 95 })
  .toFile(OUTPUT_PATH);

console.log("✓ clean non-slop og.png generated (1200x630)");
