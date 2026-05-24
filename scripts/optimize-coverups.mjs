import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const COVER_UPS_DIR = path.resolve('assets/cover-ups');
const REPORT_FILE = path.resolve('optimize-coverups-report.md');
const EXTENSION = '.jpg';
const SIZE_THRESHOLD_BYTES = Math.floor(2.5 * 1024 * 1024);
const MAX_EDGE_PX = 2400;
const JPEG_QUALITY = 85;

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

async function getJpgFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === EXTENSION)
    .map((entry) => path.join(dir, entry.name));
}

async function optimizeFile(filePath) {
  const beforeStats = await fs.stat(filePath);
  const relativePath = path.relative(process.cwd(), filePath);

  if (beforeStats.size <= SIZE_THRESHOLD_BYTES) {
    console.log(`SKIP ${relativePath} (${formatBytes(beforeStats.size)}) - under threshold`);
    return {
      type: 'skipped',
      file: relativePath,
      currentSize: beforeStats.size,
    };
  }

  const input = sharp(filePath, { failOn: 'none' });
  const metadata = await input.metadata();

  const width = metadata.width ?? null;
  const height = metadata.height ?? null;

  let resizeOptions = {};
  if (width && height) {
    resizeOptions = width >= height ? { width: MAX_EDGE_PX } : { height: MAX_EDGE_PX };
  } else {
    resizeOptions = { width: MAX_EDGE_PX, height: MAX_EDGE_PX };
  }

  const optimizedBuffer = await input
    .resize({
      ...resizeOptions,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({
      quality: JPEG_QUALITY,
      mozjpeg: true,
      progressive: true,
    })
    .toBuffer();

  await fs.writeFile(filePath, optimizedBuffer);

  const afterStats = await fs.stat(filePath);
  const delta = beforeStats.size - afterStats.size;

  console.log(`OK   ${relativePath} ${formatBytes(beforeStats.size)} -> ${formatBytes(afterStats.size)} (${formatBytes(delta)} saved)`);

  return {
    type: 'optimized',
    file: relativePath,
    beforeSize: beforeStats.size,
    afterSize: afterStats.size,
    savedSize: delta,
  };
}

async function writeReport(results) {
  const optimized = results.filter((result) => result.type === 'optimized');
  const skipped = results.filter((result) => result.type === 'skipped');
  const totalSavedBytes = optimized.reduce((sum, result) => sum + result.savedSize, 0);

  const lines = [
    '# Optimize cover-up gallery images report',
    '',
    '## Settings',
    `- Threshold: files larger than ${formatBytes(SIZE_THRESHOLD_BYTES)}`,
    `- Max edge: ${MAX_EDGE_PX}px`,
    `- JPEG quality: ${JPEG_QUALITY}`,
    '',
    '## Optimized files',
  ];

  if (optimized.length === 0) {
    lines.push('- None');
  } else {
    for (const file of optimized) {
      lines.push(`- \`${file.file}\`: ${formatBytes(file.beforeSize)} → ${formatBytes(file.afterSize)} (saved ${formatBytes(file.savedSize)})`);
    }
  }

  lines.push('', '## Skipped files');

  if (skipped.length === 0) {
    lines.push('- None');
  } else {
    for (const file of skipped) {
      lines.push(`- \`${file.file}\`: ${formatBytes(file.currentSize)}`);
    }
  }

  lines.push('', `## Total saved`, `- ${formatBytes(totalSavedBytes)}`, '');

  await fs.writeFile(REPORT_FILE, `${lines.join('\n')}`);
}

async function main() {
  const files = await getJpgFiles(COVER_UPS_DIR);

  if (files.length === 0) {
    await writeReport([]);
    console.log('No JPG files found in assets/cover-ups.');
    return;
  }

  const results = [];
  for (const filePath of files) {
    const result = await optimizeFile(filePath);
    results.push(result);
  }

  await writeReport(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
