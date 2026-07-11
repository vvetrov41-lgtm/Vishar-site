#!/usr/bin/env node
// Copies the pinned Three.js / GSAP / ScrollTrigger build artifacts from
// node_modules into assets/vendor/, byte-for-byte, so the homepage 3D
// section can load them same-origin instead of from cdnjs.cloudflare.com.
//
// Normal mode (no flags): copies node_modules -> assets/vendor, verifying
// each source file's SHA-256 against the pinned hash below before writing.
// --check mode: verifies the already-committed assets/vendor files against
// the same pinned hashes without touching node_modules or rewriting anything.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Expected SHA-256 of the exact bytes published by the pinned npm packages
// (three@0.128.0, gsap@3.12.5), independently confirmed to be byte-identical
// to what cdnjs.cloudflare.com served for the same versions at the time of
// vendoring.
const FILES = [
  {
    label: 'three.min.js',
    source: path.join(rootDir, 'node_modules/three/build/three.min.js'),
    dest: path.join(rootDir, 'assets/vendor/three/0.128.0/three.min.js'),
    sha256: '9274bbcec8d96168626c732b5d31c775aa8cfb7eaa0599bec0c175908a2c1ce2',
  },
  {
    label: 'three LICENSE',
    source: path.join(rootDir, 'node_modules/three/LICENSE'),
    dest: path.join(rootDir, 'assets/vendor/three/0.128.0/LICENSE'),
    sha256: '7dddf7c5b8fd10ee654db8857d75d104b5557889aa5a91fc4ca545ea7c07062f',
  },
  {
    label: 'gsap.min.js',
    source: path.join(rootDir, 'node_modules/gsap/dist/gsap.min.js'),
    dest: path.join(rootDir, 'assets/vendor/gsap/3.12.5/gsap.min.js'),
    sha256: '28033e449a31ebcc396e5be8b13b63152bf03094288fb5867034321927bce087',
  },
  {
    label: 'ScrollTrigger.min.js',
    source: path.join(rootDir, 'node_modules/gsap/dist/ScrollTrigger.min.js'),
    dest: path.join(rootDir, 'assets/vendor/gsap/3.12.5/ScrollTrigger.min.js'),
    sha256: 'ad33c2df9ada8a663c2147357828f980d0b7ca731ef33eb3c6e4f327c3b2cda5',
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
    console.error('\nVendor file check FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nAll vendored 3D library files match their pinned SHA-256 hashes.');
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

  console.log('\nAll 3D library files vendored successfully.');
}

const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  await runCheck();
} else {
  await runCopy();
}
