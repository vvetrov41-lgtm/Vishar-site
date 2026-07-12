#!/usr/bin/env node
// Copies the pinned @fontsource font files and OFL license files from
// node_modules into assets/vendor/fonts/, byte-for-byte, so every page can
// load Inter, Playfair Display, Bodoni Moda and IBM Plex Mono same-origin
// instead of from the Google Fonts CDN.
//
// Normal mode (no flags): copies node_modules -> assets/vendor/fonts,
// verifying each source file's SHA-256 against the pinned hash below before
// writing. --check mode: verifies the already-committed assets/vendor/fonts
// files against the same pinned hashes without touching node_modules or
// rewriting anything.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Expected SHA-256 of the exact bytes published by the pinned npm packages
// (@fontsource/inter@5.2.8, @fontsource/playfair-display@5.2.8,
// @fontsource/bodoni-moda@5.2.7, @fontsource/ibm-plex-mono@5.2.7). Only the
// latin-subset, static, roman (non-italic) files actually used by the site
// are vendored — see assets/css/fonts.css and assets/css/fonts-book.css.
const FILES = [
  {
    label: 'Inter 300 latin woff2',
    source: path.join(rootDir, 'node_modules/@fontsource/inter/files/inter-latin-300-normal.woff2'),
    dest: path.join(rootDir, 'assets/vendor/fonts/inter/5.2.8/inter-latin-300-normal.woff2'),
    sha256: 'be0276550393a72b94d673505567dceba801511d5e1ca5a87793190dc5d5a6ca',
  },
  {
    label: 'Inter 400 latin woff2',
    source: path.join(rootDir, 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2'),
    dest: path.join(rootDir, 'assets/vendor/fonts/inter/5.2.8/inter-latin-400-normal.woff2'),
    sha256: '8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc',
  },
  {
    label: 'Inter 500 latin woff2',
    source: path.join(rootDir, 'node_modules/@fontsource/inter/files/inter-latin-500-normal.woff2'),
    dest: path.join(rootDir, 'assets/vendor/fonts/inter/5.2.8/inter-latin-500-normal.woff2'),
    sha256: 'f3779f1efccc4bdcdf9c0a02ab95bf6bd092ed09c48c08cedc725889edd1d19f',
  },
  {
    label: 'Inter 600 latin woff2',
    source: path.join(rootDir, 'node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2'),
    dest: path.join(rootDir, 'assets/vendor/fonts/inter/5.2.8/inter-latin-600-normal.woff2'),
    sha256: 'f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a',
  },
  {
    label: 'Inter LICENSE',
    source: path.join(rootDir, 'node_modules/@fontsource/inter/LICENSE'),
    dest: path.join(rootDir, 'assets/vendor/fonts/inter/5.2.8/LICENSE'),
    sha256: '3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345',
  },
  {
    label: 'Playfair Display 700 latin woff2',
    source: path.join(rootDir, 'node_modules/@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff2'),
    dest: path.join(rootDir, 'assets/vendor/fonts/playfair-display/5.2.8/playfair-display-latin-700-normal.woff2'),
    sha256: '28453852ea165c47b5a941be00e418402e1407002ed87507f062a1e316328fe6',
  },
  {
    label: 'Playfair Display LICENSE',
    source: path.join(rootDir, 'node_modules/@fontsource/playfair-display/LICENSE'),
    dest: path.join(rootDir, 'assets/vendor/fonts/playfair-display/5.2.8/LICENSE'),
    sha256: 'c052aafd2a71e90bcee6e69f475029d430a10d548c08ffcae350171f0e9668b1',
  },
  {
    label: 'Bodoni Moda 500 latin woff2',
    source: path.join(rootDir, 'node_modules/@fontsource/bodoni-moda/files/bodoni-moda-latin-500-normal.woff2'),
    dest: path.join(rootDir, 'assets/vendor/fonts/bodoni-moda/5.2.7/bodoni-moda-latin-500-normal.woff2'),
    sha256: 'ec5b785abb85d087b5101a74671933b1bab5f96d9d85f868cc33964e69758748',
  },
  {
    label: 'Bodoni Moda LICENSE',
    source: path.join(rootDir, 'node_modules/@fontsource/bodoni-moda/LICENSE'),
    dest: path.join(rootDir, 'assets/vendor/fonts/bodoni-moda/5.2.7/LICENSE'),
    sha256: '6c64f717433eadd29b058d6254fe25c1ee2d249ce3772f843bb21f73285779c2',
  },
  {
    label: 'IBM Plex Mono 400 latin woff2',
    source: path.join(rootDir, 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'),
    dest: path.join(rootDir, 'assets/vendor/fonts/ibm-plex-mono/5.2.7/ibm-plex-mono-latin-400-normal.woff2'),
    sha256: '08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7',
  },
  {
    label: 'IBM Plex Mono LICENSE',
    source: path.join(rootDir, 'node_modules/@fontsource/ibm-plex-mono/LICENSE'),
    dest: path.join(rootDir, 'assets/vendor/fonts/ibm-plex-mono/5.2.7/LICENSE'),
    sha256: '23b0a9d0c6d3f140a0b77e483c5cfa6bba574325ef5cb189ed9f2fec4884533f',
  },
];

function rel(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

async function sha256Of(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCheck() {
  const failures = [];

  for (const file of FILES) {
    if (!await fileExists(file.dest)) {
      failures.push(`${rel(file.dest)}: missing`);
      continue;
    }
    const stat = await fs.stat(file.dest);
    if (stat.size === 0) {
      failures.push(`${rel(file.dest)}: empty file`);
      continue;
    }
    const actual = await sha256Of(file.dest);
    if (actual !== file.sha256) {
      failures.push(`${rel(file.dest)}: SHA-256 mismatch (expected ${file.sha256}, got ${actual})`);
      continue;
    }
    console.log(`OK   ${rel(file.dest)} (${file.label}, sha256=${actual})`);
  }

  if (failures.length > 0) {
    console.error('\nVendor font file check FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nAll vendored font files match their pinned SHA-256 hashes.');
}

async function runCopy() {
  const failures = [];

  for (const file of FILES) {
    if (!await fileExists(file.source)) {
      failures.push(`${rel(file.source)}: source missing (run "npm ci" first)`);
      continue;
    }

    const actualSourceHash = await sha256Of(file.source);
    if (actualSourceHash !== file.sha256) {
      failures.push(
        `${rel(file.source)}: SHA-256 mismatch (expected ${file.sha256}, got ${actualSourceHash}) — ` +
        'refusing to vendor unexpected bytes'
      );
      continue;
    }

    await fs.mkdir(path.dirname(file.dest), { recursive: true });
    await fs.copyFile(file.source, file.dest);

    const destHash = await sha256Of(file.dest);
    if (destHash !== file.sha256) {
      failures.push(`${rel(file.dest)}: post-copy SHA-256 mismatch (expected ${file.sha256}, got ${destHash})`);
      continue;
    }

    console.log(`Vendored ${rel(file.source)} -> ${rel(file.dest)} (sha256=${destHash})`);
  }

  if (failures.length > 0) {
    console.error('\nVendoring FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nAll font files vendored successfully.');
}

const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  await runCheck();
} else {
  await runCopy();
}
