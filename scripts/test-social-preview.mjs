#!/usr/bin/env node
// Guard against reusing the Manchester-era social card on London pages.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const imagePath = 'assets/og/og-london-2026.jpg';
const imageUrl = 'https://vishartattoo.com/' + imagePath;
const pages = [
  "index.html",
  "about/index.html",
  "aftercare/index.html",
  "ai-tools/index.html",
  "black-and-grey-realism-london/index.html",
  "book/index.html",
  "booking/index.html",
  "colour-realism-tattoo-london/index.html",
  "cover-up-tattoo-london/index.html",
  "faq/index.html",
  "large-scale-realism-tattoo-london/index.html",
  "portrait-tattoo-artist-london/index.html",
  "privacy/index.html"
];
const metadata = await sharp(imagePath).metadata();
assert.equal(metadata.format, 'jpeg', 'Social preview must be JPEG');
assert.equal(metadata.width, 1200, 'Social preview width');
assert.equal(metadata.height, 630, 'Social preview height');

for (const page of pages) {
  const html = await readFile(page, 'utf8');
  assert.ok(html.includes('<meta property="og:image" content="' + imageUrl + '">'), page + ': Open Graph image');
  assert.ok(html.includes('<meta name="twitter:image" content="' + imageUrl + '">'), page + ': Twitter image');
  assert.ok(html.includes('<meta property="og:image:width" content="1200">'), page + ': OG width');
  assert.ok(html.includes('<meta property="og:image:height" content="630">'), page + ': OG height');
  assert.ok(html.includes('<meta property="og:image:alt" content="'), page + ': OG image alt');
  assert.ok(!html.includes('/assets/og/og-2.jpg'), page + ': obsolete image must not be referenced');
}
console.log('Social previews verified for ' + pages.length + ' pages (1200×630 JPEG).');
