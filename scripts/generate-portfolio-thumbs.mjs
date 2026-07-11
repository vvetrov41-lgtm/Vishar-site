import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SOURCE_DIR = path.resolve('assets/portfolio');
const OUTPUT_DIR = path.resolve('assets/portfolio', 'thumbs');
const WIDTHS = [320, 480, 720, 960];
const FILE_NUMBERS = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, '0'));
const WEBP_QUALITY = 80;
const WEBP_EFFORT = 6;

const FORCE = process.argv.includes('--force');

function formatBytes(bytes) {
  const kb = bytes / 1024;
  return `${kb.toFixed(1)} KB`;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isUpToDate(sourcePath, outputPath) {
  if (!await fileExists(outputPath)) return false;
  const [sourceStat, outputStat] = await Promise.all([fs.stat(sourcePath), fs.stat(outputPath)]);
  return outputStat.mtimeMs >= sourceStat.mtimeMs;
}

async function generateThumb(sourcePath, outputPath, width) {
  const buffer = await sharp(sourcePath)
    .resize({ width, withoutEnlargement: true, fit: 'inside' })
    .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT, smartSubsample: true })
    .toBuffer();

  await fs.writeFile(outputPath, buffer);
  return buffer.length;
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  let inputBytesTotal = 0;
  let outputBytesTotal = 0;
  let generatedCount = 0;
  let skippedCount = 0;

  for (const number of FILE_NUMBERS) {
    const sourcePath = path.join(SOURCE_DIR, `${number}.webp`);

    if (!await fileExists(sourcePath)) {
      throw new Error(`Required full-size source is missing: assets/portfolio/${number}.webp`);
    }

    const sourceStat = await fs.stat(sourcePath);
    inputBytesTotal += sourceStat.size;

    for (const width of WIDTHS) {
      const outputPath = path.join(OUTPUT_DIR, `${number}-${width}.webp`);

      if (!FORCE && await isUpToDate(sourcePath, outputPath)) {
        skippedCount += 1;
        outputBytesTotal += (await fs.stat(outputPath)).size;
        continue;
      }

      const size = await generateThumb(sourcePath, outputPath, width);
      outputBytesTotal += size;
      generatedCount += 1;
      console.log(`${number}-${width}.webp: ${formatBytes(size)}`);
    }
  }

  console.log('');
  console.log(`Generated: ${generatedCount}, skipped (up to date): ${skippedCount}`);
  console.log(`Source (full-size WebP) total: ${formatBytes(inputBytesTotal)}`);
  console.log(`Thumbnail output total: ${formatBytes(outputBytesTotal)}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
