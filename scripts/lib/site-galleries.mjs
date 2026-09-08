/*
 * VISHAR TATTOO — portfolio / gallery markup (single source of truth)
 *
 * These grids used to be assembled in the browser. The markup below is the
 * exact same DOM the page ended up with, rendered at build time instead so
 * the raw HTML carries the images, their alt text and their links.
 * Behaviour (lightbox, before/after compare) is still attached by JS.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { rootDir, esc } from './site-content.mjs';

const THUMB_WIDTHS = [320, 480, 720, 960];

function thumbSrcset(basePath, stem) {
  return THUMB_WIDTHS.map((w) => `${basePath}thumbs/${stem}-${w}.webp ${w}w`).join(', ');
}

async function readGalleryMetadata(dirRel) {
  const raw = await readFile(path.join(rootDir, dirRel, 'metadata.json'), 'utf8');
  return JSON.parse(raw);
}

/* ── Homepage: 20-image portfolio grid ── */
export function renderHomepagePortfolioGrid() {
  const files = Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(2, '0')}.jpg`);
  const sizes = '(min-width: 768px) min(calc((100vw - 56px) / 4), 344px), calc((100vw - 40px) / 2)';

  return files.map((file, i) => {
    const stem = file.replace(/\.jpg$/i, '');
    const alt = `Realism tattoo by Vladimir Vishar, London — portfolio piece ${i + 1}`;
    return `            <button type="button" data-portfolio-index="${i}" class="aspect-[3/4] overflow-hidden bg-apple-darkGray cursor-zoom-in group relative text-left w-full" aria-label="Open portfolio image ${i + 1} of ${files.length}"><picture><source type="image/webp" srcset="${thumbSrcset('/assets/portfolio/', stem)}" sizes="${sizes}"><img src="/assets/portfolio/${file}" loading="lazy" decoding="async" width="900" height="1200" alt="${esc(alt)}" class="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105"></picture><div class="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><span class="text-xs uppercase tracking-widest font-semibold">View</span></div></button>`;
  }).join('\n');
}

/* ── Homepage: 6-image studio gallery ── */
export function renderHomepageStudioGrid() {
  const alts = [
    'Vladimir Vishar holding a tattoo convention award, with a colour realism sleeve visible',
    'Portrait of Vladimir Vishar, London realism tattoo artist',
    'Vladimir Vishar featured on the cover of Ink Legends Magazine',
    'Vladimir Vishar painting a dark realism skull piece',
    "Vladimir Vishar at a tattoo convention next to a client's healed leg tattoo",
    "Vladimir Vishar tattooing a client's arm in the studio"
  ];
  const sizes = '(min-width: 768px) min(calc((100vw - 96px) / 3), 384px), calc((100vw - 72px) / 2)';

  return alts.map((alt, i) => {
    const stem = String(i + 1).padStart(2, '0');
    return `                <div class="aspect-square bg-apple-darkGray rounded-2xl overflow-hidden group"><picture><source type="image/webp" srcset="${thumbSrcset('/assets/gallery/', stem)}" sizes="${sizes}"><img src="/assets/gallery/${stem}.jpg" loading="lazy" decoding="async" width="900" height="900" alt="${esc(alt)}" class="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity duration-500"></picture></div>`;
  }).join('\n');
}

/* ── Colour realism / black & grey speciality grids ── */
const SIMPLE_GALLERY_SIZES = '(min-width: 1024px) min(calc((100vw - 56px) / 4), 344px), (min-width: 768px) calc((100vw - 48px) / 3), calc((100vw - 40px) / 2)';

const SIMPLE_GALLERIES = {
  'colour-realism': {
    base: '/assets/colour-realism/',
    // 03's WebP sidecar keeps the irregular "03.jpg" stem from its
    // "03.jpg.JPG" source, so its thumbnails are "03.jpg-{w}.webp".
    files: [
      { file: '01.jpg', stem: '01' }, { file: '02.jpg', stem: '02' },
      { file: '03.jpg.JPG', stem: '03.jpg' }, { file: '04.jpg', stem: '04' },
      { file: '05.jpg', stem: '05' }, { file: '06.jpg', stem: '06' },
      { file: '07.jpg', stem: '07' }, { file: '08.jpg', stem: '08' },
      { file: '09.jpg', stem: '09' }, { file: '10.jpg', stem: '10' },
      { file: '11.jpg', stem: '11' }, { file: '12.jpg', stem: '12' }
    ],
    ariaLabel: (i) => `Open colour realism tattoo photo ${i + 1}`,
    alt: (i) => `Colour realism tattoo by Vladimir Vishar, London — piece ${i + 1}`
  },
  'black-grey': {
    base: '/assets/black-grey/',
    files: [
      { file: '01.jpg', stem: '01' }, { file: '02.jpg', stem: '02' },
      { file: '03.jpeg', stem: '03' }, { file: '04.jpg', stem: '04' },
      { file: '05.jpg', stem: '05' }, { file: '06.jpg', stem: '06' },
      { file: '07.jpg', stem: '07' }, { file: '08.jpg', stem: '08' },
      { file: '09.jpg', stem: '09' }, { file: '10.jpg', stem: '10' },
      { file: '11.jpg', stem: '11' }, { file: '12.jpg', stem: '12' }
    ],
    ariaLabel: (i) => `Open black and grey tattoo photo ${i + 1}`,
    alt: (i) => `Black and grey realism tattoo by Vladimir Vishar London – ${i + 1}`
  }
};

export function renderSimpleGallery(name) {
  const config = SIMPLE_GALLERIES[name];
  if (!config) throw new Error(`Unknown gallery "${name}".`);

  return config.files.map(({ file, stem }, i) => {
    const src = `${config.base}${file}`;
    const srcset = thumbSrcset(config.base, stem);
    return `    <button type="button" class="aspect-[3/4] overflow-hidden bg-apple-darkGray cursor-zoom-in group relative text-left w-full" aria-label="${esc(config.ariaLabel(i))}" data-file="${file}" data-slot="${i}" data-real="1"><picture><source srcset="${srcset}" sizes="${SIMPLE_GALLERY_SIZES}" type="image/webp"><img src="${src}" loading="lazy" decoding="async" width="900" height="1200" alt="${esc(config.alt(i))}" class="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105"></picture><div class="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><span class="text-xs uppercase tracking-widest font-semibold">View</span></div></button>`;
  }).join('\n');
}

/* ── Cover-up: 6 matched before/after pairs ── */
export function renderCoverUpPairs() {
  const cards = [];
  for (let index = 1; index <= 6; index += 1) {
    const stem = String(index).padStart(2, '0');
    const beforeAlt = `Old tattoo before cover-up, comparison ${index} by Vladimir Vishar`;
    const afterAlt = `Completed cover-up tattoo, comparison ${index} by Vladimir Vishar`;
    cards.push(`    <figure class="overflow-hidden bg-white/5 rounded-2xl border border-white/10" data-coverup-pair="${index}">
      <div class="grid grid-cols-2 gap-2 p-2">
        <div>
          <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">Before</p>
          <button type="button" data-coverup-state="before" class="group block w-full aspect-[3/4] overflow-hidden rounded-2xl bg-black cursor-zoom-in" aria-label="Open ${esc(beforeAlt)}">
            <img src="/assets/cover-ups/before-${stem}.webp" loading="lazy" decoding="async" width="900" height="1200" alt="${esc(beforeAlt)}" class="w-full h-full" style="object-fit:contain;background:#000">
          </button>
        </div>
        <div>
          <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">After</p>
          <button type="button" data-coverup-state="after" class="group block w-full aspect-[3/4] overflow-hidden rounded-2xl bg-black cursor-zoom-in" aria-label="Open ${esc(afterAlt)}">
            <img src="/assets/cover-ups/after-${stem}.webp" loading="lazy" decoding="async" width="900" height="1200" alt="${esc(afterAlt)}" class="w-full h-full" style="object-fit:contain;background:#000">
          </button>
        </div>
      </div>
    </figure>`);
  }
  return cards.join('\n');
}

/* ── Metadata-driven speciality galleries (portrait, large scale, healed) ── */
const SPECIALITY_GALLERIES = {
  portrait: { dir: 'assets/portraits', base: '/assets/portraits/', genericAlt: 'Realism portrait tattoo by Vladimir Vishar, London' },
  'large-scale': { dir: 'assets/large-scale', base: '/assets/large-scale/', genericAlt: 'Large-scale realism tattoo by Vladimir Vishar, London' },
  healed: { dir: 'assets/healed', base: '/assets/healed/', genericAlt: 'Confirmed healed realism tattoo by Vladimir Vishar' }
};

function specialityState(metadata) {
  const stems = Object.keys(metadata).filter((key) => /^\d{2}$/.test(key)).sort().slice(0, 32);
  const manifest = metadata._gallery && typeof metadata._gallery === 'object' ? metadata._gallery : {};
  const thumbnailWidths = Array.isArray(manifest.thumbnailWidths)
    ? manifest.thumbnailWidths.filter((w) => THUMB_WIDTHS.includes(w)).sort((a, b) => a - b)
    : [];
  const sourceExtension = typeof manifest.sourceExtension === 'string'
    && /^\.(?:jpe?g|webp|png)$/i.test(manifest.sourceExtension)
    ? manifest.sourceExtension.toLowerCase()
    : '.jpg';
  return { stems, thumbnailWidths, sourceExtension };
}

export async function renderSpecialityGallery(name) {
  const config = SPECIALITY_GALLERIES[name];
  if (!config) throw new Error(`Unknown speciality gallery "${name}".`);

  const metadata = await readGalleryMetadata(config.dir);
  const { stems, thumbnailWidths, sourceExtension } = specialityState(metadata);

  if (name === 'healed') return renderHealedPairs(config, metadata, stems, sourceExtension);

  const sizes = '(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw';

  return stems.map((stem, index) => {
    const info = metadata[stem] || {};
    const alt = info.alt || `${config.genericAlt} - image ${index + 1}`;
    const caption = info.caption || info.healed_for || '';
    const source = `${config.base}${stem}${sourceExtension}`;
    const img = `<img src="${source}" loading="lazy" decoding="async" width="900" height="1200" alt="${esc(alt)}" class="w-full h-full transition-transform duration-1000 group-hover:scale-105">`;
    const media = thumbnailWidths.length
      ? `<picture><source type="image/webp" srcset="${thumbnailWidths.map((w) => `${config.base}thumbs/${stem}-${w}.webp ${w}w`).join(', ')}" sizes="${sizes}">${img}</picture>`
      : img;

    return `        <figure class="overflow-hidden bg-white/5 rounded-2xl">
          <a href="${source}" target="_blank" rel="noopener" class="group block aspect-[3/4] overflow-hidden" aria-label="Open ${esc(alt)}">
            ${media}
          </a>${caption ? `
          <figcaption class="p-4 text-sm text-white/50">${esc(caption)}</figcaption>` : ''}
        </figure>`;
  }).join('\n');
}

function renderHealedPairs(config, metadata, stems, sourceExtension) {
  return stems.map((stem, index) => {
    const info = metadata[stem] || {};
    const healedAlt = info.alt || `${config.genericAlt} - image ${index + 1}`;
    const subject = healedAlt
      .replace(/^Confirmed healed\s+/i, '')
      .replace(/\s+by Vladimir Vishar$/i, '');
    const freshAlt = `Fresh-session ${subject} by Vladimir Vishar`;
    const freshSource = `${config.base}fresh/${stem}.webp`;
    const source = `${config.base}${stem}${sourceExtension}`;
    // 05 keeps its cache-busting query so the served image matches production.
    const healedSource = stem === '05' ? `${source}?v=20260907` : source;

    const media = (src, alt) => `<img src="${src}" loading="lazy" decoding="async" width="900" height="1200" alt="${esc(alt)}" class="w-full h-full transition-transform duration-1000 group-hover:scale-105" style="object-fit:contain;background:#000">`;

    return `        <figure class="overflow-hidden bg-white/5 rounded-2xl border border-white/10">
          <div class="grid grid-cols-2 gap-2 p-2">
            <div>
              <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">Fresh</p>
              <a href="${freshSource}" data-speciality-lightbox data-lightbox-alt="${esc(freshAlt)}" class="group block aspect-[3/4] overflow-hidden rounded-2xl bg-black" aria-label="Open ${esc(freshAlt)}">
                ${media(freshSource, freshAlt)}
              </a>
            </div>
            <div>
              <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">Healed</p>
              <a href="${healedSource}" data-speciality-lightbox data-lightbox-alt="${esc(healedAlt)}" class="group block aspect-[3/4] overflow-hidden rounded-2xl bg-black" aria-label="Open ${esc(healedAlt)}">
                ${media(healedSource, healedAlt)}
              </a>
            </div>
          </div>
        </figure>`;
  }).join('\n');
}
