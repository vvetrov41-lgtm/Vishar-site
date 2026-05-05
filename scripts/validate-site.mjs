#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_TAILWIND_BYTES = 10 * 1024;
const LARGE_IMAGE_BYTES = 2 * 1024 * 1024;
const REQUIRED_FILES = ['robots.txt', 'sitemap.xml', '_headers'];
const HTML_EXTENSIONS = new Set(['.html']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

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
  await checkHeadersCsp();
  await checkLocalHtmlReferences(htmlFiles);
  await checkWebpAllowlists();
  await checkLargeImagesWithoutWebpWarnings();

  printResults();

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
