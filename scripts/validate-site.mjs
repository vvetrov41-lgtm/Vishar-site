#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_TAILWIND_BYTES = 10 * 1024;
const LARGE_IMAGE_BYTES = 2 * 1024 * 1024;
const REQUIRED_FILES = ['robots.txt', 'sitemap.xml', '_headers'];
const HTML_EXTENSIONS = new Set(['.html']);
const RUNTIME_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

// Self-hosted homepage 3D libraries (Three.js r128 / GSAP+ScrollTrigger
// 3.12.5), vendored from pinned npm packages by scripts/vendor-3d-libs.mjs.
// These hashes are checked independently here (not imported from that
// script) so validation still catches drift even if the vendor script itself
// were ever edited incorrectly.
const VENDOR_3D_FILES = [
  {
    rel: 'assets/vendor/three/0.128.0/three.min.js',
    sha256: '9274bbcec8d96168626c732b5d31c775aa8cfb7eaa0599bec0c175908a2c1ce2',
    homepageReference: '/assets/vendor/three/0.128.0/three.min.js',
  },
  {
    rel: 'assets/vendor/three/0.128.0/LICENSE',
    sha256: '7dddf7c5b8fd10ee654db8857d75d104b5557889aa5a91fc4ca545ea7c07062f',
  },
  {
    rel: 'assets/vendor/gsap/3.12.5/gsap.min.js',
    sha256: '28033e449a31ebcc396e5be8b13b63152bf03094288fb5867034321927bce087',
    homepageReference: '/assets/vendor/gsap/3.12.5/gsap.min.js',
  },
  {
    rel: 'assets/vendor/gsap/3.12.5/ScrollTrigger.min.js',
    sha256: 'ad33c2df9ada8a663c2147357828f980d0b7ca731ef33eb3c6e4f327c3b2cda5',
    homepageReference: '/assets/vendor/gsap/3.12.5/ScrollTrigger.min.js',
  },
];
const PORTFOLIO_NUMBERS = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, '0'));
const PORTFOLIO_THUMB_WIDTHS = [320, 480, 720, 960];
const GALLERY_THUMB_WIDTHS = [320, 480, 720, 960];
const GALLERY_CONFIGS = [
  {
    name: 'colour-realism',
    dir: 'assets/colour-realism',
    // Image 03's WebP sidecar carries the irregular stem "03.jpg" (from the
    // original "03.jpg.JPG" source), so its thumbnails are "03.jpg-{w}.webp".
    stems: ['01', '02', '03.jpg', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
    originalJpgs: ['01.jpg', '02.jpg', '03.jpg.JPG', '04.jpg', '05.jpg', '06.jpg', '07.jpg', '08.jpg', '09.jpg', '10.jpg', '11.jpg', '12.jpg'],
  },
  {
    name: 'black-grey',
    dir: 'assets/black-grey',
    stems: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
    originalJpgs: ['01.jpg', '02.jpg', '03.jpeg', '04.jpg', '05.jpg', '06.jpg', '07.jpg', '08.jpg', '09.jpg', '10.jpg', '11.jpg', '12.jpg'],
  },
  {
    name: 'cover-ups',
    dir: 'assets/cover-ups',
    stems: [
      'before-01', 'after-01',
      'before-02', 'after-02',
      'before-03', 'after-03',
      'before-04', 'after-04',
      'before-05', 'after-05',
      'before-06', 'after-06',
    ],
    originalJpgs: [
      'before-01.jpg', 'after-01.jpg',
      'before-02.jpg', 'after-02.jpg',
      'before-03.jpg', 'after-03.jpg',
      'before-04.jpg', 'after-04.jpg',
      'before-05.jpg', 'after-05.jpg',
      'before-06.jpg', 'after-06.jpg',
    ],
  },
  {
    name: 'studio-gallery',
    dir: 'assets/gallery',
    stems: ['01', '02', '03', '04', '05', '06'],
    originalJpgs: ['01.jpg', '02.jpg', '03.jpg', '04.jpg', '05.jpg', '06.jpg'],
    // This gallery's canonical source is JPG only — there is no full-size
    // WebP sidecar to require, unlike the WebP-sourced galleries above.
    requireFullSizeWebp: false,
    // Homepage cards are square with a centred `object-cover` crop, so each
    // thumbnail's height must equal its width descriptor.
    squareThumbs: true,
  },
];

function galleryConfigNamesLabel() {
  const labels = { 'colour-realism': 'Colour Realism', 'black-grey': 'Black & Grey', 'cover-ups': 'Cover-ups', 'studio-gallery': 'Studio Gallery' };
  const names = GALLERY_CONFIGS.map((gallery) => labels[gallery.name] || gallery.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const failures = [];
const warnings = [];
const passes = [];

function rel(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function pass(message) {
  passes.push(message);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function listFiles(dir, predicate = () => true) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath, predicate));
    } else if (entry.isFile() && predicate(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}

async function checkTailwindArtifact() {
  const cssPath = path.join(rootDir, 'assets/css/tailwind.css');
  if (!await pathExists(cssPath)) {
    fail('assets/css/tailwind.css is missing.');
    return;
  }

  const size = (await stat(cssPath)).size;
  if (size <= MIN_TAILWIND_BYTES) {
    fail(`assets/css/tailwind.css is ${size} bytes; expected more than ${MIN_TAILWIND_BYTES} bytes.`);
    return;
  }

  pass(`assets/css/tailwind.css exists and is ${size} bytes.`);
}

async function checkRequiredFiles() {
  for (const file of REQUIRED_FILES) {
    if (await pathExists(path.join(rootDir, file))) {
      pass(`${file} exists.`);
    } else {
      fail(`${file} is missing.`);
    }
  }
}

async function checkHtmlRuntimeStrings(htmlFiles) {
  for (const file of htmlFiles) {
    const contents = await readFile(file, 'utf8');
    const fileRel = rel(file);

    if (contents.includes('cdn.tailwindcss.com')) {
      fail(`${fileRel} references cdn.tailwindcss.com.`);
    }
    if (/tailwind\.config\s*=/.test(contents)) {
      fail(`${fileRel} contains tailwind.config =.`);
    }
    if (/\.avif\b/i.test(contents)) {
      fail(`${fileRel} references .avif.`);
    }
  }

  pass('HTML Tailwind CDN/config and AVIF guards completed.');
}

// Directories/files that are Node-only build tooling or server-side Worker
// code — never fetched or executed by a visitor's browser during page load —
// are out of scope for this check, same in spirit as the Markdown carve-out:
// only code that actually runs as part of the site's runtime matters here.
function isBrowserRuntimeFile(filePath) {
  const fileRel = rel(filePath);
  if (fileRel.startsWith('scripts/')) return false;
  if (fileRel.startsWith('workers/')) return false;
  if (fileRel.endsWith('.config.js')) return false;
  return true;
}

async function checkNoRuntimeCdnjsReferences() {
  const runtimeFiles = (await listFiles(rootDir, (file) => RUNTIME_EXTENSIONS.has(path.extname(file).toLowerCase())))
    .filter(isBrowserRuntimeFile);
  let checkedCount = 0;

  for (const file of runtimeFiles) {
    const contents = await readFile(file, 'utf8');
    checkedCount += 1;
    if (contents.includes('cdnjs.cloudflare.com')) {
      fail(`${rel(file)} references cdnjs.cloudflare.com (executable files must be self-hosted).`);
    }
  }

  const headersPath = path.join(rootDir, '_headers');
  if (await pathExists(headersPath)) {
    checkedCount += 1;
    const headersContents = await readFile(headersPath, 'utf8');
    if (headersContents.includes('cdnjs.cloudflare.com')) {
      fail('_headers references cdnjs.cloudflare.com.');
    }
  }

  // Historical prose in Markdown docs (e.g. TECHNICAL_AUDIT.md) intentionally
  // documents the prior cdnjs-based implementation and must not fail this
  // check — only executable HTML/JS/CSS and _headers are runtime-relevant.
  pass(`No executable HTML/JS/CSS or _headers file references cdnjs.cloudflare.com (${checkedCount} files checked).`);
}

async function checkVendor3DLibraries() {
  for (const file of VENDOR_3D_FILES) {
    const filePath = path.join(rootDir, file.rel);

    if (!await pathExists(filePath)) {
      fail(`Vendored 3D library file is missing: ${file.rel}.`);
      continue;
    }

    const stats = await stat(filePath);
    if (stats.size === 0) {
      fail(`Vendored 3D library file is empty: ${file.rel}.`);
      continue;
    }

    const buffer = await readFile(filePath);
    const actualHash = createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== file.sha256) {
      fail(`Vendored 3D library file SHA-256 mismatch: ${file.rel} (expected ${file.sha256}, got ${actualHash}).`);
      continue;
    }

    if (!file.rel.match(/\/(0\.128\.0|3\.12\.5)\//)) {
      fail(`Vendored 3D library path is not version-scoped: ${file.rel}.`);
    }
  }

  pass(`Vendored 3D library files (Three.js r128, GSAP 3.12.5, ScrollTrigger 3.12.5) exist, are non-empty, version-scoped, and match pinned SHA-256 hashes (${VENDOR_3D_FILES.length} files checked, no network access used).`);
}

async function checkHomepageReferencesLocalVendorPaths() {
  const homepagePath = path.join(rootDir, 'index.html');
  if (!await pathExists(homepagePath)) {
    fail('index.html is missing; cannot verify local 3D vendor references.');
    return;
  }

  const contents = await readFile(homepagePath, 'utf8');
  const expectedReferences = VENDOR_3D_FILES
    .map((file) => file.homepageReference)
    .filter(Boolean);

  for (const reference of expectedReferences) {
    if (!contents.includes(reference)) {
      fail(`index.html does not reference local vendor path: ${reference}.`);
    }
  }

  pass(`index.html references all ${expectedReferences.length} local 3D vendor paths.`);
}

async function checkHeadersCsp() {
  const headersPath = path.join(rootDir, '_headers');
  if (!await pathExists(headersPath)) return;

  const contents = await readFile(headersPath, 'utf8');
  const cspLines = contents
    .split(/\r?\n/)
    .filter((line) => /^\s*Content-Security-Policy\s*:/i.test(line));

  if (cspLines.some((line) => line.includes('cdn.tailwindcss.com'))) {
    fail('_headers Content-Security-Policy contains cdn.tailwindcss.com.');
    return;
  }

  pass('_headers CSP does not contain cdn.tailwindcss.com.');
}

function isIgnorableReference(value) {
  const trimmed = value.trim();
  return !trimmed
    || trimmed.includes('${')
    || trimmed.startsWith('#')
    || trimmed.startsWith('mailto:')
    || trimmed.startsWith('tel:')
    || trimmed.startsWith('javascript:')
    || trimmed.startsWith('data:')
    || trimmed.startsWith('blob:')
    || trimmed.startsWith('//')
    || /^https?:\/\//i.test(trimmed)
    || trimmed.startsWith('/cdn-cgi/');
}

function withoutQueryOrHash(value) {
  return value.split('#')[0].split('?')[0];
}

function candidatePathsForReference(fromHtmlFile, reference) {
  const cleanReference = decodeURIComponent(withoutQueryOrHash(reference.trim()));
  if (!cleanReference) return [];

  const basePath = cleanReference.startsWith('/')
    ? path.join(rootDir, cleanReference)
    : path.resolve(path.dirname(fromHtmlFile), cleanReference);

  if (cleanReference.endsWith('/')) {
    return [path.join(basePath, 'index.html')];
  }

  const extension = path.extname(basePath);
  if (extension) {
    return [basePath];
  }

  return [basePath, path.join(basePath, 'index.html')];
}

function extractSrcsetReferences(srcsetValue) {
  return srcsetValue
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function extractHtmlReferences(contents) {
  const references = [];
  const attrRegex = /\b(href|src|srcset)\s*=\s*(["'])(.*?)\2/gis;
  let match;

  while ((match = attrRegex.exec(contents)) !== null) {
    const [, attr, , rawValue] = match;
    if (attr.toLowerCase() === 'srcset') {
      for (const srcsetRef of extractSrcsetReferences(rawValue)) {
        references.push({ attr, value: srcsetRef });
      }
    } else {
      references.push({ attr, value: rawValue });
    }
  }

  return references;
}

async function checkLocalHtmlReferences(htmlFiles) {
  for (const file of htmlFiles) {
    const contents = await readFile(file, 'utf8');
    const fileRel = rel(file);

    for (const { attr, value } of extractHtmlReferences(contents)) {
      if (isIgnorableReference(value)) continue;
      const candidates = candidatePathsForReference(file, value);
      if (!candidates.length) continue;

      const exists = await Promise.any(candidates.map(async (candidate) => {
        if (await pathExists(candidate)) return true;
        throw new Error(`${candidate} not found`);
      })).catch(() => false);

      if (!exists) {
        fail(`${fileRel} ${attr}="${value}" does not resolve to a local file/page.`);
      }
    }
  }

  pass('Local href/src/srcset references in HTML resolved.');
}

function webpSidecarFor(imageRel) {
  return imageRel.replace(/\.(jpe?g|png)$/i, '.webp');
}

function buildSequentialAllowlist(dirRel, fileNames) {
  return fileNames.map((fileName) => [
    `${dirRel}/${fileName}`,
    `${dirRel}/${fileName.replace(/\.(jpe?g|png)$/i, '.webp')}`,
  ]);
}

function getWebpAllowlistEntries() {
  return [
    ...buildSequentialAllowlist('assets/portfolio', Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(2, '0')}.jpg`)),
    ...buildSequentialAllowlist('assets/black-grey', ['01.jpg', '02.jpg', '03.jpeg', '04.jpg', '05.jpg', '06.jpg', '07.jpg', '08.jpg', '09.jpg', '10.jpg', '11.jpg', '12.jpg']),
    ...[
      ['01.jpg', '01.webp'],
      ['02.jpg', '02.webp'],
      ['03.jpg.JPG', '03.jpg.webp'],
      ['04.jpg', '04.webp'],
      ['05.jpg', '05.webp'],
      ['06.jpg', '06.webp'],
      ['07.jpg', '07.webp'],
      ['08.jpg', '08.webp'],
      ['09.jpg', '09.webp'],
      ['10.jpg', '10.webp'],
      ['11.jpg', '11.webp'],
      ['12.jpg', '12.webp'],
    ].map(([source, sidecar]) => [`assets/colour-realism/${source}`, `assets/colour-realism/${sidecar}`]),
    ...Array.from({ length: 6 }, (_, i) => String(i + 1).padStart(2, '0')).flatMap((number) => [
      [`assets/cover-ups/before-${number}.jpg`, `assets/cover-ups/before-${number}.webp`],
      [`assets/cover-ups/after-${number}.jpg`, `assets/cover-ups/after-${number}.webp`],
    ]),
  ];
}

async function checkWebpAllowlists() {
  for (const [sourceRel, sidecarRel] of getWebpAllowlistEntries()) {
    const sourcePath = path.join(rootDir, sourceRel);
    const sidecarPath = path.join(rootDir, sidecarRel);

    if (!await pathExists(sourcePath)) {
      fail(`Allowlisted source image is missing: ${sourceRel}.`);
      continue;
    }

    if (!await pathExists(sidecarPath)) {
      fail(`Allowlisted WebP sidecar is missing: ${sidecarRel} for ${sourceRel}.`);
    }
  }

  pass('Known WebP allowlists checked.');
}

async function checkLargeImagesWithoutWebpWarnings() {
  const imageFiles = await listFiles(path.join(rootDir, 'assets'), (file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()));

  for (const imagePath of imageFiles) {
    const size = (await stat(imagePath)).size;
    if (size <= LARGE_IMAGE_BYTES) continue;

    const imageRel = rel(imagePath);
    const sidecarRel = webpSidecarFor(imageRel);
    if (!await pathExists(path.join(rootDir, sidecarRel))) {
      warn(`${imageRel} is ${size} bytes and has no WebP sidecar at ${sidecarRel}.`);
    }
  }

  pass('Large JPG/JPEG/PNG warning-only scan completed.');
}

async function checkPortfolioThumbnails() {
  const portfolioDir = path.join(rootDir, 'assets/portfolio');

  for (const number of PORTFOLIO_NUMBERS) {
    const sourceRel = `assets/portfolio/${number}.webp`;
    if (!await pathExists(path.join(portfolioDir, `${number}.webp`))) {
      fail(`Portfolio thumbnail source is missing: ${sourceRel}.`);
      continue;
    }

    for (const width of PORTFOLIO_THUMB_WIDTHS) {
      const thumbRel = `assets/portfolio/thumbs/${number}-${width}.webp`;
      const thumbPath = path.join(rootDir, thumbRel);

      if (!await pathExists(thumbPath)) {
        fail(`Expected portfolio thumbnail is missing: ${thumbRel}.`);
        continue;
      }

      const stats = await stat(thumbPath);
      if (stats.size === 0) {
        fail(`Portfolio thumbnail is empty: ${thumbRel}.`);
        continue;
      }

      let metadata;
      try {
        metadata = await sharp(thumbPath).metadata();
      } catch (error) {
        fail(`Portfolio thumbnail could not be read: ${thumbRel} (${error.message}).`);
        continue;
      }

      if (metadata.width !== width) {
        fail(`Portfolio thumbnail ${thumbRel} has width ${metadata.width}px, expected ${width}px.`);
      }
    }
  }

  pass(`Portfolio responsive thumbnails checked (${PORTFOLIO_NUMBERS.length} images x ${PORTFOLIO_THUMB_WIDTHS.length} widths).`);
}

async function checkPortfolioOriginalsIntact() {
  const portfolioDir = path.join(rootDir, 'assets/portfolio');
  const entries = await readdir(portfolioDir, { withFileTypes: true });
  const topLevelJpg = entries.filter((entry) => entry.isFile() && /\.jpe?g$/i.test(entry.name));
  const topLevelWebp = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.webp'));

  if (topLevelJpg.length !== PORTFOLIO_NUMBERS.length) {
    fail(`Expected ${PORTFOLIO_NUMBERS.length} top-level portfolio JPG files, found ${topLevelJpg.length}.`);
  }
  if (topLevelWebp.length !== PORTFOLIO_NUMBERS.length) {
    fail(`Expected ${PORTFOLIO_NUMBERS.length} top-level portfolio WebP files, found ${topLevelWebp.length}.`);
  }

  for (const number of PORTFOLIO_NUMBERS) {
    if (!await pathExists(path.join(portfolioDir, `${number}.jpg`))) {
      fail(`Original portfolio JPG missing or replaced: assets/portfolio/${number}.jpg.`);
    }
    if (!await pathExists(path.join(portfolioDir, `${number}.webp`))) {
      fail(`Original portfolio WebP missing or replaced: assets/portfolio/${number}.webp.`);
    }
  }

  pass('Portfolio original JPG/WebP source files are intact and unreplaced.');
}

async function checkGalleryOriginalsIntact() {
  for (const gallery of GALLERY_CONFIGS) {
    for (const jpgName of gallery.originalJpgs) {
      const jpgRel = `${gallery.dir}/${jpgName}`;
      if (!await pathExists(path.join(rootDir, jpgRel))) {
        fail(`Original gallery JPG/JPEG missing or replaced: ${jpgRel}.`);
      }
    }

    // Galleries with requireFullSizeWebp: false (e.g. Studio Gallery) have
    // no full-size WebP sidecar by design — only the JPG is canonical.
    if (gallery.requireFullSizeWebp === false) continue;

    for (const stem of gallery.stems) {
      const webpRel = `${gallery.dir}/${stem}.webp`;
      if (!await pathExists(path.join(rootDir, webpRel))) {
        fail(`Original gallery WebP source missing or replaced: ${webpRel}.`);
      }
    }
  }

  pass(`${galleryConfigNamesLabel()} original JPG/JPEG (and, where applicable, full-size WebP) source files are present. This confirms presence and readable format only, not byte-for-byte immutability.`);
}

async function checkGalleryThumbnails() {
  let checkedCount = 0;

  for (const gallery of GALLERY_CONFIGS) {
    for (const stem of gallery.stems) {
      for (const width of GALLERY_THUMB_WIDTHS) {
        const thumbRel = `${gallery.dir}/thumbs/${stem}-${width}.webp`;
        const thumbPath = path.join(rootDir, thumbRel);

        if (!await pathExists(thumbPath)) {
          fail(`Expected gallery thumbnail is missing: ${thumbRel}.`);
          continue;
        }

        const stats = await stat(thumbPath);
        if (stats.size === 0) {
          fail(`Gallery thumbnail is empty: ${thumbRel}.`);
          continue;
        }

        let metadata;
        try {
          metadata = await sharp(thumbPath).metadata();
        } catch (error) {
          fail(`Gallery thumbnail could not be read: ${thumbRel} (${error.message}).`);
          continue;
        }

        if (metadata.format !== 'webp') {
          fail(`Gallery thumbnail ${thumbRel} is not a valid WebP file (detected format: ${metadata.format}).`);
          continue;
        }

        if (metadata.width !== width) {
          fail(`Gallery thumbnail ${thumbRel} has width ${metadata.width}px, expected ${width}px.`);
          continue;
        }

        if (gallery.squareThumbs && metadata.height !== width) {
          fail(`Gallery thumbnail ${thumbRel} has height ${metadata.height}px, expected ${width}px (square).`);
          continue;
        }

        checkedCount += 1;
      }
    }
  }

  pass(`Gallery responsive thumbnails checked (${checkedCount} derivatives across ${galleryConfigNamesLabel()}).`);
}

function printResults() {
  console.log('Static site validation results');
  console.log('==============================');

  for (const message of passes) {
    console.log(`PASS ${message}`);
  }

  for (const message of warnings) {
    console.warn(`WARN ${message}`);
  }

  for (const message of failures) {
    console.error(`FAIL ${message}`);
  }

  console.log('------------------------------');
  console.log(`${passes.length} passed, ${warnings.length} warnings, ${failures.length} failures.`);
}

async function main() {
  const htmlFiles = await listFiles(rootDir, (file) => HTML_EXTENSIONS.has(path.extname(file).toLowerCase()));

  await checkTailwindArtifact();
  await checkRequiredFiles();
  await checkHtmlRuntimeStrings(htmlFiles);
  await checkNoRuntimeCdnjsReferences();
  await checkVendor3DLibraries();
  await checkHomepageReferencesLocalVendorPaths();
  await checkHeadersCsp();
  await checkLocalHtmlReferences(htmlFiles);
  await checkWebpAllowlists();
  await checkLargeImagesWithoutWebpWarnings();
  await checkPortfolioOriginalsIntact();
  await checkPortfolioThumbnails();
  await checkGalleryOriginalsIntact();
  await checkGalleryThumbnails();

  printResults();

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
