import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const WIDTHS = [320, 480, 720, 960];
const WEBP_QUALITY = 80;
const WEBP_EFFORT = 6;

const GALLERIES = [
  {
    name: 'colour-realism',
    sourceDir: path.resolve('assets/colour-realism'),
    outputDir: path.resolve('assets/colour-realism', 'thumbs'),
    // Image 03's full-size WebP sidecar is "03.jpg.webp" (irregular double
    // extension carried over from the original "03.jpg.JPG" source), so its
    // stem is "03.jpg" rather than a plain zero-padded number.
    stems: ['01', '02', '03.jpg', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
  },
  {
    name: 'black-grey',
    sourceDir: path.resolve('assets/black-grey'),
    outputDir: path.resolve('assets/black-grey', 'thumbs'),
    stems: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
  },
  {
    name: 'cover-ups',
    sourceDir: path.resolve('assets/cover-ups'),
    outputDir: path.resolve('assets/cover-ups', 'thumbs'),
    stems: [
      'before-01', 'after-01',
      'before-02', 'after-02',
      'before-03', 'after-03',
      'before-04', 'after-04',
      'before-05', 'after-05',
      'before-06', 'after-06',
    ],
  },
];

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

async function processGallery(gallery) {
  await fs.mkdir(gallery.outputDir, { recursive: true });

  let inputBytesTotal = 0;
  let outputBytesTotal = 0;
  let generatedCount = 0;
  let skippedCount = 0;

  for (const stem of gallery.stems) {
    const sourcePath = path.join(gallery.sourceDir, `${stem}.webp`);

    if (!await fileExists(sourcePath)) {
      throw new Error(`Required full-size source is missing: ${path.relative(process.cwd(), sourcePath)}`);
    }

    const sourceStat = await fs.stat(sourcePath);
    inputBytesTotal += sourceStat.size;

    for (const width of WIDTHS) {
      const outputPath = path.join(gallery.outputDir, `${stem}-${width}.webp`);

      if (!FORCE && await isUpToDate(sourcePath, outputPath)) {
        skippedCount += 1;
        outputBytesTotal += (await fs.stat(outputPath)).size;
        continue;
      }

      const size = await generateThumb(sourcePath, outputPath, width);
      outputBytesTotal += size;
      generatedCount += 1;
      console.log(`${gallery.name}/thumbs/${stem}-${width}.webp: ${formatBytes(size)}`);
    }
  }

  return { generatedCount, skippedCount, inputBytesTotal, outputBytesTotal };
}

async function main() {
  let generatedTotal = 0;
  let skippedTotal = 0;
  let inputBytesGrand = 0;
  let outputBytesGrand = 0;

  for (const gallery of GALLERIES) {
    const result = await processGallery(gallery);
    generatedTotal += result.generatedCount;
    skippedTotal += result.skippedCount;
    inputBytesGrand += result.inputBytesTotal;
    outputBytesGrand += result.outputBytesTotal;

    console.log('');
    console.log(`${gallery.name}: generated ${result.generatedCount}, skipped (up to date) ${result.skippedCount}`);
    console.log(`${gallery.name}: source (full-size WebP) total ${formatBytes(result.inputBytesTotal)}`);
    console.log(`${gallery.name}: thumbnail output total ${formatBytes(result.outputBytesTotal)}`);
  }

  console.log('');
  console.log(`Generated: ${generatedTotal}, skipped (up to date): ${skippedTotal}`);
  console.log(`Source (full-size WebP) grand total: ${formatBytes(inputBytesGrand)}`);
  console.log(`Thumbnail output grand total: ${formatBytes(outputBytesGrand)}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
