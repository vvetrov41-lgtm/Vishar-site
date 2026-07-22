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
const SITE_HOST = 'vishartattoo.com';
const NOT_FOUND_FILE_REL = '404.html';

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
// Self-hosted fonts (Inter, Playfair Display, Bodoni Moda, IBM Plex Mono),
// vendored from pinned @fontsource/* npm packages by
// scripts/vendor-fonts.mjs. These hashes are checked independently here
// (not imported from that script) so validation still catches drift even
// if the vendor script itself were ever edited incorrectly.
const VENDOR_FONT_FILES = [
  { rel: 'assets/vendor/fonts/inter/5.2.8/inter-latin-300-normal.woff2', sha256: 'be0276550393a72b94d673505567dceba801511d5e1ca5a87793190dc5d5a6ca' },
  { rel: 'assets/vendor/fonts/inter/5.2.8/inter-latin-400-normal.woff2', sha256: '8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc' },
  { rel: 'assets/vendor/fonts/inter/5.2.8/inter-latin-500-normal.woff2', sha256: 'f3779f1efccc4bdcdf9c0a02ab95bf6bd092ed09c48c08cedc725889edd1d19f' },
  { rel: 'assets/vendor/fonts/inter/5.2.8/inter-latin-600-normal.woff2', sha256: 'f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a' },
  { rel: 'assets/vendor/fonts/inter/5.2.8/LICENSE', sha256: '3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345' },
  { rel: 'assets/vendor/fonts/playfair-display/5.2.8/playfair-display-latin-700-normal.woff2', sha256: '28453852ea165c47b5a941be00e418402e1407002ed87507f062a1e316328fe6' },
  { rel: 'assets/vendor/fonts/playfair-display/5.2.8/LICENSE', sha256: 'c052aafd2a71e90bcee6e69f475029d430a10d548c08ffcae350171f0e9668b1' },
  { rel: 'assets/vendor/fonts/bodoni-moda/5.2.7/bodoni-moda-latin-500-normal.woff2', sha256: 'ec5b785abb85d087b5101a74671933b1bab5f96d9d85f868cc33964e69758748' },
  { rel: 'assets/vendor/fonts/bodoni-moda/5.2.7/LICENSE', sha256: '6c64f717433eadd29b058d6254fe25c1ee2d249ce3772f843bb21f73285779c2' },
  { rel: 'assets/vendor/fonts/ibm-plex-mono/5.2.7/ibm-plex-mono-latin-400-normal.woff2', sha256: '08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7' },
  { rel: 'assets/vendor/fonts/ibm-plex-mono/5.2.7/LICENSE', sha256: '23b0a9d0c6d3f140a0b77e483c5cfa6bba574325ef5cb189ed9f2fec4884533f' },
];
const FONTS_STYLESHEET_REFERENCE = '/assets/css/fonts.css';
const FONTS_BOOK_STYLESHEET_REFERENCE = '/assets/css/fonts-book.css';
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

function parseRobotsGroups(contents) {
  const lines = contents.split(/\r?\n/).map((line) => line.trim());
  const groups = [];
  let current = null;

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;

    const uaMatch = /^User-agent:\s*(.+)$/i.exec(line);
    if (uaMatch) {
      if (current && current.rules.length > 0) {
        groups.push(current);
        current = null;
      }
      if (!current) current = { agents: [], rules: [] };
      current.agents.push(uaMatch[1].trim());
      continue;
    }

    const ruleMatch = /^(Allow|Disallow):\s*(.*)$/i.exec(line);
    if (ruleMatch && current) {
      current.rules.push({ type: ruleMatch[1].toLowerCase(), path: ruleMatch[2].trim() });
    }
  }

  if (current) groups.push(current);
  return groups;
}

async function checkRobotsAiCrawlers() {
  const robotsPath = path.join(rootDir, 'robots.txt');
  if (!await pathExists(robotsPath)) {
    fail('robots.txt is missing; cannot verify AI crawler rules.');
    return;
  }

  const contents = await readFile(robotsPath, 'utf8');
  const groups = parseRobotsGroups(contents);

  function checkGroupAllowsSiteButNotApi(agent) {
    const group = groups.find((g) => g.agents.some((a) => a.toLowerCase() === agent.toLowerCase()));
    if (!group) {
      fail(`robots.txt does not declare an explicit User-agent: ${agent} group.`);
      return;
    }

    if (group.rules.some((r) => r.type === 'disallow' && (r.path === '/' || r.path === ''))) {
      fail(`robots.txt disallows ${agent} from "/".`);
    }
    if (!group.rules.some((r) => r.type === 'allow' && r.path === '/')) {
      fail(`robots.txt does not explicitly Allow: / for ${agent}.`);
    }
    if (!group.rules.some((r) => r.type === 'disallow' && r.path === '/api/')) {
      fail(`robots.txt does not Disallow: /api/ for ${agent}.`);
    }
  }

  // Search and user-request crawlers are kept separate from training/product
  // control tokens so their different purposes remain explicit in robots.txt.
  const searchAndUserAgents = [
    'OAI-SearchBot',
    'ChatGPT-User',
    'Claude-SearchBot',
    'Claude-User',
    'PerplexityBot',
    'Perplexity-User',
  ];
  const trainingAndProductAgents = ['GPTBot', 'ClaudeBot', 'Google-Extended'];

  for (const agent of [...searchAndUserAgents, ...trainingAndProductAgents]) {
    checkGroupAllowsSiteButNotApi(agent);
  }
  checkGroupAllowsSiteButNotApi('*');

  const sitemapLines = contents.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^Sitemap:/i.test(line));
  const expectedSitemapLine = 'Sitemap: https://vishartattoo.com/sitemap.xml';
  if (sitemapLines.length !== 1 || sitemapLines[0] !== expectedSitemapLine) {
    fail(`robots.txt Sitemap declaration is not exactly "${expectedSitemapLine}" (found: ${sitemapLines.length ? sitemapLines.join(' | ') : 'none'}).`);
  }

  pass(`robots.txt explicitly allows ${searchAndUserAgents.length} AI search/user crawlers and ${trainingAndProductAgents.length} training/product crawler tokens to access the public site, keeps /api/ disallowed for those crawlers and the wildcard User-agent: * group, and declares the sitemap exactly as expected.`);
}

async function checkLlmsTxt() {
  const llmsPath = path.join(rootDir, 'llms.txt');
  if (!await pathExists(llmsPath)) {
    fail('llms.txt is missing.');
    return;
  }

  const contents = await readFile(llmsPath, 'utf8');
  if (!contents.trim()) {
    fail('llms.txt is empty.');
    return;
  }

  const urls = contents.match(/https?:\/\/[^\s)>\]]+/g) || [];
  if (urls.length === 0) {
    fail('llms.txt contains no page URLs.');
    return;
  }

  let checkedPageUrls = 0;
  for (const url of urls) {
    if (/^http:\/\//i.test(url)) {
      fail(`llms.txt contains a non-HTTPS URL: "${url}".`);
      continue;
    }
    if (/(^|\.)pages\.dev(\/|$)/i.test(url)) {
      fail(`llms.txt contains a pages.dev preview URL: "${url}".`);
      continue;
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      fail(`llms.txt contains an invalid URL: "${url}".`);
      continue;
    }

    if (parsed.protocol !== 'https:' || parsed.hostname !== SITE_HOST) {
      fail(`llms.txt URL is not a canonical https://${SITE_HOST}/ apex-domain URL: "${url}".`);
      continue;
    }
    if (!parsed.pathname.endsWith('/')) {
      fail(`llms.txt URL does not use the trailing-slash format: "${url}".`);
      continue;
    }

    const filePath = parsed.pathname === '/'
      ? path.join(rootDir, 'index.html')
      : path.join(rootDir, parsed.pathname.slice(1), 'index.html');

    if (!await pathExists(filePath)) {
      fail(`llms.txt references "${url}" but no local page exists for it.`);
      continue;
    }

    checkedPageUrls += 1;
  }

  pass(`llms.txt exists, is non-empty, and contains ${checkedPageUrls} canonical HTTPS apex-domain trailing-slash page URLs, each resolving to an existing local page (no pages.dev, www, or HTTP URLs).`);
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

async function checkBookingWindowSingleSource(htmlFiles) {
  const componentsPath = path.join(rootDir, 'components.js');
  if (!await pathExists(componentsPath)) {
    fail('components.js is missing; cannot verify booking availability.');
    return;
  }

  const components = await readFile(componentsPath, 'utf8');
  const configMatches = [...components.matchAll(/const BOOKING_WINDOW\s*=\s*(['"`])([^\n]*?)\1\s*;/g)];
  if (configMatches.length !== 1) {
    fail(`components.js has ${configMatches.length} BOOKING_WINDOW definitions; expected exactly 1.`);
  } else if (!configMatches[0][2].trim()) {
    fail('components.js BOOKING_WINDOW is empty.');
  }

  const expectedFallback = 'Check current availability';
  const markerPattern = /<([a-z][\\w-]*)\\b[^>]*\\bdata-booking-window\\b[^>]*>([\\s\\S]*?)<\\/\\1>/gi;
  const datedAvailabilityPattern = /(?:booking|availability)[^\\n]{0,120}\\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+20\\d{2}\\b/i;
  let markerCount = 0;

  for (const file of htmlFiles) {
    const contents = await readFile(file, 'utf8');
    const fileRel = rel(file);
    const plainText = contents.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ');

    if (datedAvailabilityPattern.test(plainText)) {
      fail(`${fileRel} hard-codes a dated booking/availability message; use data-booking-window instead.`);
    }

    for (const match of contents.matchAll(markerPattern)) {
      markerCount += 1;
      const fallback = match[2].replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim();
      if (fallback !== expectedFallback) {
        fail(`${fileRel} data-booking-window fallback is "${fallback}", expected "${expectedFallback}".`);
      }
    }
  }

  if (markerCount === 0) {
    fail('No data-booking-window markers found in HTML.');
  }

  pass(`Booking availability has one BOOKING_WINDOW source in components.js and ${markerCount} neutral HTML fallback markers with no hard-coded dates.`);
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

async function checkVendorFontFiles() {
  for (const file of VENDOR_FONT_FILES) {
    const filePath = path.join(rootDir, file.rel);

    if (!await pathExists(filePath)) {
      fail(`Vendored font file is missing: ${file.rel}.`);
      continue;
    }

    const stats = await stat(filePath);
    if (stats.size === 0) {
      fail(`Vendored font file is empty: ${file.rel}.`);
      continue;
    }

    const buffer = await readFile(filePath);
    const actualHash = createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== file.sha256) {
      fail(`Vendored font file SHA-256 mismatch: ${file.rel} (expected ${file.sha256}, got ${actualHash}).`);
      continue;
    }

    if (!file.rel.match(/\/(5\.2\.8|5\.2\.7)\//)) {
      fail(`Vendored font path is not version-scoped: ${file.rel}.`);
    }
  }

  pass(`Vendored font files (Inter 5.2.8, Playfair Display 5.2.8, Bodoni Moda 5.2.7, IBM Plex Mono 5.2.7) exist, are non-empty, version-scoped, and match pinned SHA-256 hashes (${VENDOR_FONT_FILES.length} files checked, no network access used).`);
}

async function checkPagesReferenceLocalFontStylesheets(htmlFiles) {
  let checkedCount = 0;

  for (const file of htmlFiles) {
    const contents = await readFile(file, 'utf8');
    const fileRel = rel(file);
    const isBookPage = fileRel === 'book/index.html';

    if (!contents.includes(FONTS_STYLESHEET_REFERENCE)) {
      fail(`${fileRel} does not reference ${FONTS_STYLESHEET_REFERENCE}.`);
    }

    if (isBookPage) {
      if (!contents.includes(FONTS_BOOK_STYLESHEET_REFERENCE)) {
        fail(`${fileRel} does not reference ${FONTS_BOOK_STYLESHEET_REFERENCE}.`);
      }
    } else if (contents.includes(FONTS_BOOK_STYLESHEET_REFERENCE)) {
      fail(`${fileRel} references ${FONTS_BOOK_STYLESHEET_REFERENCE}, but only book/index.html should.`);
    }

    checkedCount += 1;
  }

  pass(`All ${checkedCount} HTML pages reference ${FONTS_STYLESHEET_REFERENCE}, and only book/index.html additionally references ${FONTS_BOOK_STYLESHEET_REFERENCE}.`);
}

async function checkNoRuntimeGoogleFontsReferences() {
  const runtimeFiles = (await listFiles(rootDir, (file) => RUNTIME_EXTENSIONS.has(path.extname(file).toLowerCase())))
    .filter(isBrowserRuntimeFile);
  let checkedCount = 0;

  for (const file of runtimeFiles) {
    const contents = await readFile(file, 'utf8');
    checkedCount += 1;
    if (contents.includes('fonts.googleapis.com') || contents.includes('fonts.gstatic.com')) {
      fail(`${rel(file)} references fonts.googleapis.com or fonts.gstatic.com (fonts must be self-hosted).`);
    }
    if (/rel\s*=\s*["']preconnect["']\s+href\s*=\s*["']https:\/\/fonts\.(googleapis|gstatic)\.com["']/i.test(contents)) {
      fail(`${rel(file)} still contains a Google Fonts preconnect link.`);
    }
  }

  const headersPath = path.join(rootDir, '_headers');
  if (await pathExists(headersPath)) {
    checkedCount += 1;
    const headersContents = await readFile(headersPath, 'utf8');
    if (headersContents.includes('fonts.googleapis.com') || headersContents.includes('fonts.gstatic.com')) {
      fail('_headers references fonts.googleapis.com or fonts.gstatic.com.');
    }
  }

  // Historical prose in Markdown docs (e.g. TECHNICAL_AUDIT.md) intentionally
  // documents the prior Google-Fonts-based implementation and must not fail
  // this check — only executable HTML/JS/CSS and _headers are runtime-relevant.
  pass(`No executable HTML/JS/CSS or _headers file references fonts.googleapis.com, fonts.gstatic.com, or a Google Fonts preconnect link (${checkedCount} files checked).`);
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

  if (cspLines.some((line) => line.includes('fonts.googleapis.com') || line.includes('fonts.gstatic.com'))) {
    fail('_headers Content-Security-Policy still permits fonts.googleapis.com or fonts.gstatic.com.');
    return;
  }

  pass('_headers CSP does not contain cdn.tailwindcss.com, fonts.googleapis.com, or fonts.gstatic.com.');
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

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Matches opening tags like `<h1>`, `<h1 class="...">`, or one whose
// attributes wrap across lines. `[^>]` matches newlines (unlike `.` without
// the `s` flag), so multi-line attribute lists are still counted correctly.
// The `(?:\s[^>]*)?` (rather than `[^>]*`) ensures "h1" is a whole tag name,
// not a prefix of something like a hypothetical `<h1x>`.
function findTags(contents, tagName) {
  const regex = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, 'gi');
  return contents.match(regex) || [];
}

function extractTagAttributes(tagSource) {
  const attrs = {};
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;

  while ((match = attrRegex.exec(tagSource)) !== null) {
    const [, name, , doubleQuoted, singleQuoted] = match;
    const value = doubleQuoted !== undefined ? doubleQuoted : singleQuoted;
    attrs[name.toLowerCase()] = decodeXmlEntities(value);
  }

  return attrs;
}

// Maps a repo-relative HTML file path to the site path it is expected to be
// served at (e.g. `about/index.html` -> `/about/`). Returns null for files
// with no such clean path (currently only 404.html), which are excluded from
// canonical/sitemap correspondence checks.
function expectedPublicPathFor(fileRel) {
  if (fileRel === 'index.html') return '/';
  if (fileRel.endsWith('/index.html')) return `/${fileRel.slice(0, -'index.html'.length)}`;
  return null;
}

function expectedCanonicalUrlFor(fileRel) {
  const publicPath = expectedPublicPathFor(fileRel);
  return publicPath === null ? null : `https://${SITE_HOST}${publicPath}`;
}

function isValidIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

async function readSitemapEntries() {
  const sitemapPath = path.join(rootDir, 'sitemap.xml');
  if (!await pathExists(sitemapPath)) return null;

  const contents = await readFile(sitemapPath, 'utf8');
  const urlBlocks = contents.match(/<url(?:\s[^>]*)?>[\s\S]*?<\/url>/gi) || [];

  return urlBlocks.map((block) => {
    const locMatch = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/i.exec(block);
    const lastmodMatch = /<lastmod(?:\s[^>]*)?>([\s\S]*?)<\/lastmod>/i.exec(block);
    return {
      loc: locMatch ? decodeXmlEntities(locMatch[1].trim()) : null,
      lastmod: lastmodMatch ? decodeXmlEntities(lastmodMatch[1].trim()) : null,
    };
  });
}

async function checkCanonicalTags(htmlFiles) {
  const sitemapEntries = await readSitemapEntries();
  const sitemapLocs = new Set((sitemapEntries || []).map((entry) => entry.loc).filter(Boolean));
  const indexablePages = htmlFiles.filter((file) => rel(file) !== NOT_FOUND_FILE_REL);

  for (const file of indexablePages) {
    const fileRel = rel(file);
    const contents = await readFile(file, 'utf8');

    const canonicalTags = findTags(contents, 'link').filter((tag) => {
      const attrs = extractTagAttributes(tag);
      return attrs.rel && attrs.rel.toLowerCase() === 'canonical';
    });

    if (canonicalTags.length !== 1) {
      fail(`${fileRel} has ${canonicalTags.length} canonical link tags; expected exactly 1.`);
      continue;
    }

    const href = extractTagAttributes(canonicalTags[0]).href;
    if (!href) {
      fail(`${fileRel} canonical link tag has no href.`);
      continue;
    }

    let url;
    try {
      url = new URL(href);
    } catch {
      fail(`${fileRel} canonical href is not a valid absolute URL: "${href}".`);
      continue;
    }

    if (url.protocol !== 'https:') {
      fail(`${fileRel} canonical URL is not HTTPS: "${href}".`);
    }
    if (url.hostname !== SITE_HOST) {
      fail(`${fileRel} canonical host is "${url.hostname}", expected "${SITE_HOST}": "${href}".`);
    }
    if (url.search || url.hash) {
      fail(`${fileRel} canonical URL contains a query string or fragment: "${href}".`);
    }
    if (!url.pathname.endsWith('/')) {
      fail(`${fileRel} canonical URL does not use the trailing-slash format: "${href}".`);
    }

    const expectedUrl = expectedCanonicalUrlFor(fileRel);
    if (expectedUrl && href !== expectedUrl) {
      fail(`${fileRel} canonical URL "${href}" does not match its expected page path "${expectedUrl}".`);
    }

    if (!sitemapLocs.has(href)) {
      fail(`${fileRel} canonical URL "${href}" does not match any <loc> in sitemap.xml.`);
    }
  }

  pass(`Canonical link tags checked on ${indexablePages.length} indexable HTML pages (exactly one absolute HTTPS apex-host trailing-slash canonical matching the page's path and a sitemap <loc>).`);
}

async function checkSitemapConsistency(htmlFiles) {
  const sitemapEntries = await readSitemapEntries();
  if (sitemapEntries === null) {
    fail('sitemap.xml is missing; cannot validate sitemap consistency.');
    return;
  }
  if (sitemapEntries.length === 0) {
    fail('sitemap.xml contains no <url> entries.');
    return;
  }

  const seenLocs = new Set();
  const duplicateLocs = new Set();
  for (const entry of sitemapEntries) {
    if (!entry.loc) {
      fail('sitemap.xml contains a <url> entry with no <loc>.');
      continue;
    }
    if (seenLocs.has(entry.loc)) {
      duplicateLocs.add(entry.loc);
    }
    seenLocs.add(entry.loc);
  }
  for (const loc of duplicateLocs) {
    fail(`sitemap.xml contains duplicate <loc>: ${loc}.`);
  }

  for (const entry of sitemapEntries) {
    if (!entry.loc) continue;

    let url;
    try {
      url = new URL(entry.loc);
    } catch {
      fail(`sitemap.xml <loc> is not a valid absolute URL: "${entry.loc}".`);
      continue;
    }

    if (url.protocol !== 'https:') {
      fail(`sitemap.xml <loc> is not HTTPS: "${entry.loc}".`);
    }
    if (url.hostname !== SITE_HOST) {
      fail(`sitemap.xml <loc> host is "${url.hostname}", expected "${SITE_HOST}": "${entry.loc}".`);
    }
    if (!url.pathname.endsWith('/')) {
      fail(`sitemap.xml <loc> does not use the trailing-slash format: "${entry.loc}".`);
    }
    if (url.pathname.toLowerCase().includes('404')) {
      fail(`sitemap.xml must not include the 404 page: "${entry.loc}".`);
    }

    if (!entry.lastmod) {
      fail(`sitemap.xml <url> for "${entry.loc}" is missing <lastmod>.`);
    } else if (!isValidIsoDate(entry.lastmod)) {
      fail(`sitemap.xml <lastmod> for "${entry.loc}" is not a valid YYYY-MM-DD date: "${entry.lastmod}".`);
    }
  }

  const indexablePages = htmlFiles.filter((file) => rel(file) !== NOT_FOUND_FILE_REL);
  const expectedUrlToFile = new Map();
  for (const file of indexablePages) {
    const fileRel = rel(file);
    const expectedUrl = expectedCanonicalUrlFor(fileRel);
    if (expectedUrl) expectedUrlToFile.set(expectedUrl, fileRel);
  }

  const locCounts = new Map();
  for (const entry of sitemapEntries) {
    if (!entry.loc) continue;
    locCounts.set(entry.loc, (locCounts.get(entry.loc) || 0) + 1);
    if (!expectedUrlToFile.has(entry.loc)) {
      fail(`sitemap.xml <loc> "${entry.loc}" does not correspond to any indexable HTML page in the repository.`);
    }
  }

  for (const [expectedUrl, fileRel] of expectedUrlToFile) {
    const count = locCounts.get(expectedUrl) || 0;
    if (count !== 1) {
      fail(`${fileRel} expected exactly one sitemap.xml entry for "${expectedUrl}", found ${count}.`);
    }
  }

  pass(`sitemap.xml has ${sitemapEntries.length} <url> entries with unique, HTTPS apex-host, trailing-slash <loc> values and valid <lastmod> dates, each corresponding to exactly one indexable HTML page (404.html excluded).`);
}

async function checkH1Counts(htmlFiles) {
  for (const file of htmlFiles) {
    const fileRel = rel(file);
    const contents = await readFile(file, 'utf8');
    const h1Count = findTags(contents, 'h1').length;
    if (h1Count !== 1) {
      fail(`${fileRel} has ${h1Count} <h1> elements; expected exactly 1.`);
    }
  }

  pass(`Exactly one <h1> element found on each of ${htmlFiles.length} HTML pages.`);
}

async function checkTitlesAndDescriptions(htmlFiles) {
  const indexablePages = htmlFiles.filter((file) => rel(file) !== NOT_FOUND_FILE_REL);
  const titlesByFile = new Map();
  const descriptionsByFile = new Map();

  for (const file of htmlFiles) {
    const fileRel = rel(file);
    const contents = await readFile(file, 'utf8');
    const isIndexable = fileRel !== NOT_FOUND_FILE_REL;

    const titleMatches = [...contents.matchAll(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/gi)];
    if (titleMatches.length !== 1) {
      fail(`${fileRel} has ${titleMatches.length} <title> elements; expected exactly 1.`);
    } else {
      const titleText = decodeXmlEntities(titleMatches[0][1]).trim();
      if (!titleText) {
        fail(`${fileRel} <title> is empty.`);
      } else if (isIndexable) {
        titlesByFile.set(fileRel, titleText);
      }
    }

    if (!isIndexable) continue;

    const descriptionTags = findTags(contents, 'meta').filter((tag) => {
      const attrs = extractTagAttributes(tag);
      return attrs.name && attrs.name.toLowerCase() === 'description';
    });

    if (descriptionTags.length !== 1) {
      fail(`${fileRel} has ${descriptionTags.length} meta description tags; expected exactly 1.`);
      continue;
    }

    const descriptionText = (extractTagAttributes(descriptionTags[0]).content || '').trim();
    if (!descriptionText) {
      fail(`${fileRel} meta description is empty.`);
      continue;
    }
    descriptionsByFile.set(fileRel, descriptionText);
  }

  const filesByTitle = new Map();
  for (const [fileRel, title] of titlesByFile) {
    if (!filesByTitle.has(title)) filesByTitle.set(title, []);
    filesByTitle.get(title).push(fileRel);
  }
  for (const [title, files] of filesByTitle) {
    if (files.length > 1) fail(`Duplicate <title> "${title}" used by: ${files.join(', ')}.`);
  }

  const filesByDescription = new Map();
  for (const [fileRel, description] of descriptionsByFile) {
    if (!filesByDescription.has(description)) filesByDescription.set(description, []);
    filesByDescription.get(description).push(fileRel);
  }
  for (const [description, files] of filesByDescription) {
    if (files.length > 1) fail(`Duplicate meta description "${description}" used by: ${files.join(', ')}.`);
  }

  pass(`Titles checked on ${htmlFiles.length} HTML pages and meta descriptions checked on ${indexablePages.length} indexable pages (each present, non-empty, and unique across indexable pages).`);
}

async function checkRobotsIndexability(htmlFiles) {
  for (const file of htmlFiles) {
    const fileRel = rel(file);
    const contents = await readFile(file, 'utf8');
    const isNotFoundPage = fileRel === NOT_FOUND_FILE_REL;

    const robotsTags = findTags(contents, 'meta').filter((tag) => {
      const attrs = extractTagAttributes(tag);
      return attrs.name && attrs.name.toLowerCase() === 'robots';
    });

    if (robotsTags.length !== 1) {
      fail(`${fileRel} has ${robotsTags.length} robots meta tags; expected exactly 1.`);
      continue;
    }

    const content = (extractTagAttributes(robotsTags[0]).content || '').toLowerCase();

    if (isNotFoundPage) {
      if (!content.includes('noindex')) {
        fail(`${fileRel} robots meta tag does not contain noindex: "${content}".`);
      }
    } else if (content.includes('noindex')) {
      fail(`${fileRel} is an indexable page but its robots meta tag contains noindex: "${content}".`);
    } else if (!content.includes('index')) {
      fail(`${fileRel} robots meta tag does not allow indexing: "${content}".`);
    }
  }

  pass(`Robots meta tags checked on ${htmlFiles.length} HTML pages (indexable pages allow indexing; 404.html contains noindex).`);
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
  await checkRobotsAiCrawlers();
  await checkLlmsTxt();
  await checkHtmlRuntimeStrings(htmlFiles);
  await checkBookingWindowSingleSource(htmlFiles);
  await checkNoRuntimeCdnjsReferences();
  await checkVendor3DLibraries();
  await checkHomepageReferencesLocalVendorPaths();
  await checkVendorFontFiles();
  await checkPagesReferenceLocalFontStylesheets(htmlFiles);
  await checkNoRuntimeGoogleFontsReferences();
  await checkHeadersCsp();
  await checkCanonicalTags(htmlFiles);
  await checkSitemapConsistency(htmlFiles);
  await checkH1Counts(htmlFiles);
  await checkTitlesAndDescriptions(htmlFiles);
  await checkRobotsIndexability(htmlFiles);
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
