// Rasterizes web/favicon.svg into the PNG icon set the PWA manifest needs.
// Re-run with `node scripts/gen-icons.mjs` whenever the favicon changes.

import { Resvg } from '@resvg/resvg-js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const SRC  = resolve(REPO, 'web/favicon.svg');
const OUT  = resolve(REPO, 'web/icons');

const THEME = '#ffb43a';   // matches manifest theme_color

const raw = await readFile(SRC, 'utf-8');
const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');

// Wrap the 64x64 favicon content in a sized canvas, optionally with padding
// (for maskable icons: safe area must be a centered circle of diameter 0.8 * canvas)
// and an opaque background (for iOS apple-touch-icon: no transparency).
function wrap({ size, padding = 0, bg = 'none' }) {
  const inset = Math.round(size * padding);
  const innerSize = size - inset * 2;
  const scale = innerSize / 64;
  const bgRect = bg === 'none' ? '' : `<rect width="${size}" height="${size}" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${bgRect}<g transform="translate(${inset}, ${inset}) scale(${scale})">${inner}</g></svg>`;
}

const VARIANTS = [
  { name: 'icon-192.png',             size: 192, padding: 0,    bg: 'none'  },
  { name: 'icon-512.png',             size: 512, padding: 0,    bg: 'none'  },
  // Maskable: OS may crop outside an 80%-diameter centered circle. Pad so the
  // brand circle fits inside the safe area; fill the rest with theme color so
  // the cropped corners look intentional rather than transparent.
  { name: 'icon-maskable-192.png',    size: 192, padding: 0.10, bg: THEME   },
  { name: 'icon-maskable-512.png',    size: 512, padding: 0.10, bg: THEME   },
  // iOS apple-touch-icon: PNG transparency is shown as black behind the icon.
  // Fill with theme color so the brand circle blends into a clean square.
  { name: 'apple-touch-icon-180.png', size: 180, padding: 0,    bg: THEME   },
];

await mkdir(OUT, { recursive: true });

const fontOpts = {
  loadSystemFonts: true,
  defaultFontFamily: 'Noto Serif CJK SC',
};

for (const v of VARIANTS) {
  const svg = wrap(v);
  const r = new Resvg(svg, { font: fontOpts });
  const png = r.render().asPng();
  await writeFile(resolve(OUT, v.name), png);
  console.log(`  ${v.name.padEnd(30)} ${(png.length / 1024).toFixed(1)} KB`);
}

console.log('Done.');
