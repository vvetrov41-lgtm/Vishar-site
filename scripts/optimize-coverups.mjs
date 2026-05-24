import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const COVER_UPS_DIR = path.resolve('assets/cover-ups');
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

  if (beforeStats.size <= SIZE_THRESHOLD_BYTES) {
    console.log(`SKIP ${path.relative(process.cwd(), filePath)} (${formatBytes(beforeStats.size)}) - under threshold`);
    return;
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

  console.log(
    `OK   ${path.relative(process.cwd(), filePath)} ${formatBytes(beforeStats.size)} -> ${formatBytes(afterStats.size)} (${formatBytes(delta)} saved)`
  );
}

async function main() {
  const files = await getJpgFiles(COVER_UPS_DIR);

  if (files.length === 0) {
    console.log('No JPG files found in assets/cover-ups.');
    return;
  }

  for (const filePath of files) {
    await optimizeFile(filePath);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
