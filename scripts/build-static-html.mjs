#!/usr/bin/env node
/*
 * Renders the shared site content (nav, footer, portfolio/gallery grids,
 * portfolio cross-links) into the committed static HTML files.
 *
 * Source of truth: scripts/lib/site-content.mjs and scripts/lib/site-galleries.mjs.
 * Target: the `<!-- build:KEY -->` / `<!-- /build:KEY -->` marker pairs in the
 * page HTML. Everything between a marker pair is regenerated; everything else
 * is left untouched.
 *
 *   node scripts/build-static-html.mjs           write the files
 *   node scripts/build-static-html.mjs --check   fail if any file is stale
 *
 * The output is committed, exactly like assets/css/tailwind.css, so the
 * Cloudflare Pages deployment keeps serving plain static files with no build
 * step of its own.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  rootDir,
  renderNav,
  renderFooter,
  renderPortfolioCrosslinks,
  renderHomepagePortfolioCollections,
  renderHomepageApproach
} from './lib/site-content.mjs';

import {
  renderHomepagePortfolioGrid,
  renderHomepageStudioGrid,
  renderSimpleGallery,
  renderCoverUpPairs,
  renderSpecialityGallery
} from './lib/site-galleries.mjs';

// Every public HTML page, its PAGE_ID, and the generated blocks it carries.
// `nav` and `footer` are implicit on every page.
const PAGES = [
  { file: 'index.html', pageId: 'home', blocks: ['portfolio-grid', 'portfolio-collections', 'studio-grid', 'homepage-approach'] },
  { file: 'about/index.html', pageId: 'about' },
  { file: 'aftercare/index.html', pageId: 'aftercare' },
  { file: 'ai-tools/index.html', pageId: 'ai-tools' },
  { file: 'book/index.html', pageId: 'book' },
  { file: 'booking/index.html', pageId: 'booking' },
  { file: 'faq/index.html', pageId: 'faq' },
  { file: 'privacy/index.html', pageId: 'privacy' },
  { file: 'privacy/meta/index.html', pageId: 'privacy' },
  { file: '404.html', pageId: '' },
  { file: 'colour-realism-tattoo-london/index.html', pageId: 'colour-realism', blocks: ['gallery', 'crosslinks'] },
  { file: 'black-and-grey-realism-london/index.html', pageId: 'black-grey', blocks: ['gallery', 'crosslinks'] },
  { file: 'cover-up-tattoo-london/index.html', pageId: 'cover-up', blocks: ['gallery', 'crosslinks'] },
  { file: 'portrait-tattoo-artist-london/index.html', pageId: 'portrait', blocks: ['gallery', 'crosslinks'] },
  { file: 'large-scale-realism-tattoo-london/index.html', pageId: 'large-scale', blocks: ['gallery', 'crosslinks'] },
  { file: 'healed-tattoos/index.html', pageId: 'healed', blocks: ['gallery', 'crosslinks'] }
];

async function blocksFor(page) {
  const blocks = { nav: renderNav(page.pageId), footer: renderFooter() };

  for (const key of page.blocks || []) {
    switch (key) {
      case 'portfolio-grid':
        blocks[key] = renderHomepagePortfolioGrid();
        break;
      case 'studio-grid':
        blocks[key] = renderHomepageStudioGrid();
        break;
      case 'portfolio-collections':
        blocks[key] = renderHomepagePortfolioCollections();
        break;
      case 'homepage-approach':
        blocks[key] = renderHomepageApproach();
        break;
      case 'crosslinks':
        blocks[key] = renderPortfolioCrosslinks(page.pageId);
        break;
      case 'gallery':
        blocks[key] = await galleryFor(page.pageId);
        break;
      default:
        throw new Error(`${page.file}: unknown block "${key}".`);
    }
  }

  return blocks;
}

function galleryFor(pageId) {
  if (pageId === 'colour-realism' || pageId === 'black-grey') return renderSimpleGallery(pageId);
  if (pageId === 'cover-up') return renderCoverUpPairs();
  return renderSpecialityGallery(pageId);
}

function applyBlock(contents, key, markup, fileRel) {
  const open = `<!-- build:${key} -->`;
  const close = `<!-- /build:${key} -->`;

  const start = contents.indexOf(open);
  if (start === -1) throw new Error(`${fileRel}: missing marker ${open}.`);
  if (contents.indexOf(open, start + open.length) !== -1) {
    throw new Error(`${fileRel}: marker ${open} appears more than once.`);
  }

  const end = contents.indexOf(close, start);
  if (end === -1) throw new Error(`${fileRel}: missing marker ${close}.`);

  // Reuse the indentation of the opening marker for the generated block.
  const lineStart = contents.lastIndexOf('\n', start) + 1;
  const indent = /^[ \t]*/.exec(contents.slice(lineStart, start))[0];
  const body = markup.split('\n').map((line) => (line ? indent + line : line)).join('\n');

  return `${contents.slice(0, start + open.length)}\n${body}\n${indent}${contents.slice(end)}`;
}

export async function buildStaticHtml({ write = true } = {}) {
  const stale = [];

  for (const page of PAGES) {
    const filePath = path.join(rootDir, page.file);
    const original = await readFile(filePath, 'utf8');
    let updated = original;

    const blocks = await blocksFor(page);
    for (const [key, markup] of Object.entries(blocks)) {
      updated = applyBlock(updated, key, markup, page.file);
    }

    if (updated === original) continue;
    stale.push(page.file);
    if (write) await writeFile(filePath, updated, 'utf8');
  }

  return stale;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const check = process.argv.includes('--check');
  try {
    const stale = await buildStaticHtml({ write: !check });
    if (!stale.length) {
      console.log(`Static HTML is up to date (${PAGES.length} pages).`);
    } else if (check) {
      console.error('Static HTML is out of date. Run `npm run build:html` and commit the result.');
      for (const file of stale) console.error(`  - ${file}`);
      process.exit(1);
    } else {
      console.log(`Updated ${stale.length} of ${PAGES.length} pages:`);
      for (const file of stale) console.log(`  - ${file}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
