#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

let sharp;
try {
  ({ default: sharp } = await import('sharp'));
} catch (error) {
  console.error('❌ sharp is required but not available.');
  console.error('Run: npm install');
  console.error(error?.message || error);
  process.exit(1);
}

const ROOT = process.cwd();
const ASSETS_DIR = path.join(ROOT, 'assets');
const JSON_REPORT_PATH = path.join(ROOT, 'IMAGE_OPTIMIZATION_REPORT.json');
const MD_REPORT_PATH = path.join(ROOT, 'IMAGE_OPTIMIZATION_REPORT.md');

const VALID_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const DEFAULT_LIMIT = 15;
const MAX_WIDTH = 2400;
const WEBP_QUALITY = 85;
const AVIF_QUALITY = 50;
const FORCE = /^true$/i.test(process.env.FORCE || '');

const envLimit = Number.parseInt(process.env.IMAGE_LIMIT || '', 10);
const IMAGE_LIMIT = Number.isInteger(envLimit) && envLimit > 0 ? envLimit : DEFAULT_LIMIT;

const toPosix = p => p.split(path.sep).join('/');

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walk(full));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!VALID_EXTS.has(ext)) continue;
    out.push(full);
  }
  return out;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(2)} ${units[i]}`;
}

async function shouldSkipDerivative(originalStat, derivativePath) {
  if (FORCE) return false;
  if (!await fileExists(derivativePath)) return false;
  const derivativeStat = await fs.stat(derivativePath);
  return derivativeStat.mtimeMs >= originalStat.mtimeMs;
}

async function optimizeOne(filePath) {
  const stat = await fs.stat(filePath);
  const rel = toPosix(path.relative(ROOT, filePath));
  const parsed = path.parse(filePath);
  const webpPath = path.join(parsed.dir, `${parsed.name}.webp`);
  const avifPath = path.join(parsed.dir, `${parsed.name}.avif`);

  const base = sharp(filePath, { failOn: 'none' });
  const metadata = await base.metadata();
  const originalWidth = metadata.width || null;

  const needsResize = Boolean(originalWidth && originalWidth > MAX_WIDTH);
  const pipeline = needsResize
    ? sharp(filePath, { failOn: 'none' }).resize({
        width: MAX_WIDTH,
        fit: 'inside',
        withoutEnlargement: true
      })
    : sharp(filePath, { failOn: 'none' });

  const result = {
    file: rel,
    originalBytes: stat.size,
    originalWidth,
    resizedToWidth: needsResize ? MAX_WIDTH : originalWidth,
    skipped: false,
    webp: { path: toPosix(path.relative(ROOT, webpPath)), bytes: null, skipped: false },
    avif: { path: toPosix(path.relative(ROOT, avifPath)), bytes: null, skipped: false }
  };

  const skipWebp = await shouldSkipDerivative(stat, webpPath);
  if (skipWebp) {
    result.webp.skipped = true;
    result.webp.bytes = (await fs.stat(webpPath)).size;
  } else {
    await pipeline.clone().webp({ quality: WEBP_QUALITY, effort: 5 }).toFile(webpPath);
    result.webp.bytes = (await fs.stat(webpPath)).size;
  }

  const skipAvif = await shouldSkipDerivative(stat, avifPath);
  if (skipAvif) {
    result.avif.skipped = true;
    result.avif.bytes = (await fs.stat(avifPath)).size;
  } else {
    await pipeline.clone().avif({ quality: AVIF_QUALITY, effort: 6 }).toFile(avifPath);
    result.avif.bytes = (await fs.stat(avifPath)).size;
  }

  result.skipped = result.webp.skipped && result.avif.skipped;
  return result;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Image Optimization Report');
  lines.push('');
  lines.push(`- Generated at: ${report.generatedAt}`);
  lines.push(`- Source directory: ${report.assetsDir}`);
  lines.push(`- Image limit: ${report.limit}`);
  lines.push(`- FORCE mode: ${report.force}`);
  lines.push(`- Resize threshold: ${MAX_WIDTH}px`);
  lines.push(`- WebP quality: ${WEBP_QUALITY}`);
  lines.push(`- AVIF quality: ${AVIF_QUALITY}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Candidates scanned: ${report.scanned}`);
  lines.push(`- Optimized set: ${report.optimizedCount}`);
  lines.push(`- Derivatives written: ${report.derivativesWritten}`);
  lines.push(`- Derivatives skipped (up-to-date): ${report.derivativesSkipped}`);
  lines.push(`- Original total: ${fmtBytes(report.originalTotal)}`);
  lines.push(`- WebP total: ${fmtBytes(report.webpTotal)}`);
  lines.push(`- AVIF total: ${fmtBytes(report.avifTotal)}`);
  lines.push('');
  lines.push('## Per-file results');
  lines.push('');
  lines.push('| File | Original | WebP | AVIF | Resize | Status |');
  lines.push('|---|---:|---:|---:|---:|---|');

  for (const item of report.items) {
    const status = item.skipped ? 'skipped (up-to-date)' : 'generated/updated';
    const resize = item.originalWidth && item.originalWidth > MAX_WIDTH ? `${item.originalWidth}→${MAX_WIDTH}` : (item.originalWidth || 'n/a');
    lines.push(
      `| ${item.file} | ${fmtBytes(item.originalBytes)} | ${fmtBytes(item.webp.bytes)}${item.webp.skipped ? ' (skip)' : ''} | ${fmtBytes(item.avif.bytes)}${item.avif.skipped ? ' (skip)' : ''} | ${resize} | ${status} |`
    );
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Original JPG/PNG files are preserved and never overwritten.');
  lines.push('- This workflow only creates sidecar `.webp` and `.avif` files.');
  lines.push('- HTML `<picture>` migration should happen in a separate implementation phase.');
  return lines.join('\n');
}

async function main() {
  if (!await fileExists(ASSETS_DIR)) {
    throw new Error(`assets directory not found: ${ASSETS_DIR}`);
  }

  const all = await walk(ASSETS_DIR);
  const sized = await Promise.all(
    all.map(async file => ({ file, stat: await fs.stat(file) }))
  );

  sized.sort((a, b) => b.stat.size - a.stat.size);
  const selected = sized.slice(0, IMAGE_LIMIT);

  const items = [];
  for (const candidate of selected) {
    const item = await optimizeOne(candidate.file);
    items.push(item);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    assetsDir: toPosix(path.relative(ROOT, ASSETS_DIR) || 'assets'),
    force: FORCE,
    limit: IMAGE_LIMIT,
    scanned: all.length,
    optimizedCount: items.length,
    derivativesWritten: items.reduce((acc, i) => acc + (i.webp.skipped ? 0 : 1) + (i.avif.skipped ? 0 : 1), 0),
    derivativesSkipped: items.reduce((acc, i) => acc + (i.webp.skipped ? 1 : 0) + (i.avif.skipped ? 1 : 0), 0),
    originalTotal: items.reduce((acc, i) => acc + i.originalBytes, 0),
    webpTotal: items.reduce((acc, i) => acc + (i.webp.bytes || 0), 0),
    avifTotal: items.reduce((acc, i) => acc + (i.avif.bytes || 0), 0),
    items
  };

  await fs.writeFile(JSON_REPORT_PATH, JSON.stringify(report, null, 2));
  await fs.writeFile(MD_REPORT_PATH, `${renderMarkdown(report)}\n`);

  console.log('\nImage optimization complete.');
  console.log(`Scanned candidates: ${report.scanned}`);
  console.log(`Optimized set: ${report.optimizedCount}`);
  console.log(`Original total: ${fmtBytes(report.originalTotal)}`);
  console.log(`WebP total: ${fmtBytes(report.webpTotal)}`);
  console.log(`AVIF total: ${fmtBytes(report.avifTotal)}`);
  console.log(`Derivatives written: ${report.derivativesWritten}`);
  console.log(`Derivatives skipped: ${report.derivativesSkipped}`);
  console.log(`Reports: ${toPosix(path.relative(ROOT, MD_REPORT_PATH))}, ${toPosix(path.relative(ROOT, JSON_REPORT_PATH))}`);
}

main().catch(error => {
  console.error('❌ Image optimization failed.');
  console.error(error?.stack || error);
  process.exit(1);
});
