import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const TARGET_MAP = {
  'cover-ups': 'assets/cover-ups',
  portfolio: 'assets/portfolio',
  'black-and-grey': 'assets/black-grey',
  'colour-realism': 'assets/colour-realism',
  hero: 'assets/hero',
};

const VALID_EXTENSIONS = new Set(['.jpg', '.jpeg']);
const SIZE_THRESHOLD_BYTES = Math.floor(2.5 * 1024 * 1024);
const MAX_EDGE_PX = 2400;
const JPEG_QUALITY = 85;

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function resolveTargetKey() {
  const target = (process.argv[2] || process.env.OPTIMIZE_TARGET || '').trim().toLowerCase();

  if (!target || !Object.hasOwn(TARGET_MAP, target)) {
    const allowed = Object.keys(TARGET_MAP).join(', ');
    throw new Error(`Invalid or missing target "${target || '<empty>'}". Allowed targets: ${allowed}`);
  }

  return target;
}

async function getJpegFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .filter((entry) => VALID_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name));
}

async function optimizeFile(filePath) {
  const beforeStats = await fs.stat(filePath);
  const relativePath = path.relative(process.cwd(), filePath);

  if (beforeStats.size <= SIZE_THRESHOLD_BYTES) {
    return {
      type: 'skipped',
      file: relativePath,
      currentSize: beforeStats.size,
      reason: 'under-threshold',
    };
  }

  const input = sharp(filePath, { failOn: 'none' });
  const metadata = await input.metadata();

  const width = metadata.width ?? null;
  const height = metadata.height ?? null;

  const resizeOptions = width && height
    ? (width >= height ? { width: MAX_EDGE_PX } : { height: MAX_EDGE_PX })
    : { width: MAX_EDGE_PX, height: MAX_EDGE_PX };

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

  return {
    type: 'optimized',
    file: relativePath,
    beforeSize: beforeStats.size,
    afterSize: afterStats.size,
    savedSize: delta,
  };
}

async function writeReport(target, directory, results) {
  const optimized = results.filter((result) => result.type === 'optimized');
  const skipped = results.filter((result) => result.type === 'skipped');
  const totalSavedBytes = optimized.reduce((sum, result) => sum + result.savedSize, 0);

  const reportPath = path.resolve(`optimize-images-${target}-report.md`);

  const lines = [
    `# Optimize images report (${target})`,
    '',
    '## Settings',
    `- Target: \`${target}\``,
    `- Directory: \`${directory}\``,
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
      lines.push(`- \`${file.file}\`: ${formatBytes(file.currentSize)} (under 2.5 MB)`);
    }
  }

  lines.push('', '## Total saved', `- ${formatBytes(totalSavedBytes)}`, '');

  await fs.writeFile(reportPath, lines.join('\n'));
  return reportPath;
}

async function main() {
  const target = resolveTargetKey();
  const relativeDir = TARGET_MAP[target];
  const targetDir = path.resolve(relativeDir);

  try {
    await fs.access(targetDir);
  } catch {
    throw new Error(`Mapped target directory does not exist for target "${target}": ${relativeDir} (${targetDir})`);
  }

  const files = await getJpegFiles(targetDir);

  if (files.length === 0) {
    const reportPath = await writeReport(target, relativeDir, []);
    console.log(`No JPG/JPEG files found in ${relativeDir}.`);
    console.log(`Report written: ${path.relative(process.cwd(), reportPath)}`);
    return;
  }

  const results = [];
  for (const filePath of files) {
    const result = await optimizeFile(filePath);
    results.push(result);
  }

  const reportPath = await writeReport(target, relativeDir, results);
  console.log(`Report written: ${path.relative(process.cwd(), reportPath)}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
