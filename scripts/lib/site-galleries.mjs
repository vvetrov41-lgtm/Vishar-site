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

/* ── Homepage: 12 selected tattoo images; full galleries are on their speciality pages ── */
export function renderHomepagePortfolioGrid() {
  const files = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, '0')}.jpg`);
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

/* ── Cover-up: 17 matched before/after pairs ── */
export function renderCoverUpPairs() {
  const cards = [];
  for (let index = 1; index <= 17; index += 1) {
    const stem = String(index).padStart(2, '0');
    const beforeAlt = index === 17 ? 'Two old dreamcatcher tattoos on upper arm before cover-up, comparison 17 by Vladimir Vishar' : index === 15 ? 'Old dumbbell tattoo on forearm before cover-up, comparison 15 by Vladimir Vishar' : index === 16 ? 'Old Manchester City crest tattoo on calf before cover-up, comparison 16 by Vladimir Vishar' : index === 14 ? 'Old faded floral tattoo on forearm before cover-up, comparison 14 by Vladimir Vishar' : index === 13 ? 'Old faded cross tattoo on upper arm before cover-up, AI-expanded framing, comparison 13 by Vladimir Vishar' : index === 11 ? 'Old tribal chest and shoulder tattoo before cover-up, comparison 11 by Vladimir Vishar' : index === 12 ? 'Old illustrated forearm tattoo before cover-up, comparison 12 by Vladimir Vishar' : index === 9 ? 'Old illustrated woman portrait on upper arm before cover-up, comparison 9 by Vladimir Vishar' : index === 10 ? 'Old forearm tattoo with lion cover-up stencil applied before tattooing, comparison 10 by Vladimir Vishar' : index === 8 ? 'Old tiger and tribal upper arm tattoo before cover-up, comparison 8 by Vladimir Vishar' : index === 1 ? 'Old black and turquoise tribal tattoo on upper arm before cover-up, comparison 1 by Vladimir Vishar' : index === 2 ? 'Old cursive quote tattoo on ribs before cover-up, comparison 2 by Vladimir Vishar' : index === 3 ? 'Old red pentagram and goat head outline tattoo on forearm before cover-up, comparison 3 by Vladimir Vishar' : index === 4 ? 'Old skull, crossed blades and flames tattoo on upper arm before cover-up, comparison 4 by Vladimir Vishar' : index === 5 ? 'Old cross and script ribbon tattoo on ribs before cover-up, comparison 5 by Vladimir Vishar' : index === 6 ? 'Old faded horned cartoon face tattoo on calf before cover-up, comparison 6 by Vladimir Vishar' : index === 7 ? 'Old faded long-tailed big cat tattoo on forearm before cover-up, comparison 7 by Vladimir Vishar' : `Old tattoo before cover-up, comparison ${index} by Vladimir Vishar`;
    const afterAlt = index === 17 ? 'Completed black and grey warrior portrait with winged helmet upper arm cover-up tattoo, comparison 17 by Vladimir Vishar' : index === 15 ? 'Completed black and grey roaring tiger forearm cover-up tattoo, comparison 15 by Vladimir Vishar' : index === 16 ? 'Completed black and grey Viking portrait calf cover-up tattoo, comparison 16 by Vladimir Vishar' : index === 14 ? 'Completed colour realism leopard forearm cover-up tattoo, comparison 14 by Vladimir Vishar' : index === 13 ? 'Completed black and grey Spartan helmet upper arm cover-up tattoo, comparison 13 by Vladimir Vishar' : index === 11 ? 'Completed black and grey wolf and mountain landscape chest cover-up tattoo, comparison 11 by Vladimir Vishar' : index === 12 ? 'Completed black and grey samurai mask forearm cover-up tattoo, comparison 12 by Vladimir Vishar' : index === 9 ? 'Completed colour castle at night upper arm cover-up tattoo, comparison 9 by Vladimir Vishar' : index === 10 ? 'Completed realistic lion forearm cover-up tattoo, comparison 10 by Vladimir Vishar' : index === 8 ? 'Completed black and grey Viking skull upper arm cover-up tattoo, comparison 8 by Vladimir Vishar' : index === 1 ? 'Black and grey realism cover-up of a shadowed face with skeletal fingers on upper arm, comparison 1 by Vladimir Vishar' : index === 2 ? 'Black and grey realistic samurai helmet and mask cover-up on ribs, comparison 2 by Vladimir Vishar' : index === 3 ? 'Colour realism horror portrait with dark eyes and a hand against the face, forearm cover-up, comparison 3 by Vladimir Vishar' : index === 4 ? 'Colour realism cover-up of a dark skull surrounded by red and orange flames on upper arm, comparison 4 by Vladimir Vishar' : index === 5 ? 'Black and grey realistic raven perched on a twisted branch, rib cover-up, comparison 5 by Vladimir Vishar' : index === 6 ? 'Colour realism cover-up of a large purple-pink flower on calf, comparison 6 by Vladimir Vishar' : index === 7 ? 'Black and grey realism cover-up with a bone-like hand amid water splashes on forearm, comparison 7 by Vladimir Vishar' : `Completed cover-up tattoo, comparison ${index} by Vladimir Vishar`;
    const responsive = (state) => index >= 7 ? ` srcset="${thumbSrcset('/assets/cover-ups/', `${state}-${stem}`).replace('960w', index === 10 && state === 'before' ? '904w' : index === 12 && state === 'after' ? '864w' : '960w')}" sizes="(min-width: 1232px) 280px, (min-width: 768px) 25vw, 50vw"` : '';
    cards.push(`    <figure class="overflow-hidden bg-white/5 rounded-2xl border border-white/10" data-coverup-pair="${index}">
      <div class="grid grid-cols-2 gap-2 p-2">
        <div>
          <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">${index === 10 ? 'Before (stencil)' : 'Before'}</p>
          <button type="button" data-coverup-state="before" class="group block w-full aspect-[3/4] overflow-hidden rounded-2xl bg-black cursor-zoom-in" aria-label="Open ${esc(beforeAlt)}">
            <img src="/assets/cover-ups/before-${stem}.webp"${responsive('before')} loading="lazy" decoding="async" width="${index === 17 ? 1229 : index === 15 ? 1228 : index === 14 ? 1155 : index === 13 ? 1122 : index === 10 ? 904 : index >= 9 ? 1152 : index === 8 ? 968 : index === 7 ? 1152 : 900}" height="${index === 13 ? 1402 : index === 8 ? 1290 : index >= 7 ? 1536 : 1200}" alt="${esc(beforeAlt)}" class="w-full h-full" style="object-fit:contain;background:#000">
          </button>
        </div>
        <div>
          <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">After</p>
          <button type="button" data-coverup-state="after" class="group block w-full aspect-[3/4] overflow-hidden rounded-2xl bg-black cursor-zoom-in" aria-label="Open ${esc(afterAlt)}">
            <img src="/assets/cover-ups/after-${stem}.webp"${responsive('after')} loading="lazy" decoding="async" width="${index === 16 ? 1024 : index === 13 ? 1229 : index === 12 ? 864 : index === 11 ? 1024 : index >= 8 ? 1152 : index === 7 ? 1113 : 900}" height="${index >= 7 ? 1536 : 1200}" alt="${esc(afterAlt)}" class="w-full h-full" style="object-fit:contain;background:#000">
          </button>
        </div>
      </div>
    </figure>`);
    if (index === 4) cards.push(`    <section id="cover-up-pricing" class="md:col-span-2 py-6">
        <div class="max-w-[900px] mx-auto rounded-3xl border border-white/10 bg-white/5 p-8 md:p-10 text-center">
            <h2 class="text-2xl md:text-4xl font-semibold mb-4 tracking-tight">How much does a cover-up tattoo cost?</h2>
            <p class="text-xl text-white mb-4">£140/hr · £980 for 7 hours</p>
            <p class="text-white/60 leading-relaxed max-w-2xl mx-auto">Cover-ups usually take a similar amount of time to colour realism, even in black and grey. The price depends on the old tattoo and your new design. You pay for tattooing time used; any touch-up after healing is charged separately and is not included in the estimate.</p>
            <div class="mt-6 flex flex-col sm:flex-row items-center justify-center gap-4">
                <a href="/tattoo-price-calculator/" class="px-6 py-3 border border-white/20 rounded-full font-medium hover:bg-white/10 transition-colors">Estimate your budget</a>
                <a href="/booking/" class="px-6 py-3 bg-white text-black rounded-full font-medium hover:bg-white/90 transition-colors">Get a free photo assessment</a>
            </div>
        </div>
    </section>`);
    if (index === 8) cards.push(`    <section id="cover-up-options" class="md:col-span-2 py-6 px-0">
        <div class="max-w-[900px] mx-auto">
            <div class="rounded-3xl border border-white/10 bg-white/5 p-8 md:p-10">
                <h2 class="text-2xl font-semibold mb-6">Key things to know about cover-ups</h2>
                <div class="space-y-6 text-white/50 leading-relaxed">
                    <p><span class="text-white font-medium">Darker covers darker.</span> Dark ink generally needs darker areas in the new design, often with more space around the original tattoo. Lighter, faded tattoos give more design freedom.</p>
                    <p><span class="text-white font-medium">Size matters.</span> The cover-up usually needs to be larger than the original. How much larger depends on the old tattoo. I'll explain the required dimensions clearly.</p>
                    <p><span class="text-white font-medium">Laser is optional.</span> Many tattoos can be covered directly. In some cases, even one or two laser lightening sessions may significantly expand the design options. The studio does not offer laser treatment or advice on laser treatment.</p>
                    <p><span class="text-white font-medium">Both styles work.</span> Cover-ups can be done in <a href="/colour-realism-tattoo-london/" class="text-white underline underline-offset-4 decoration-white/20 hover:decoration-white/60 transition-colors">colour realism</a> or <a href="/black-and-grey-realism-london/" class="text-white underline underline-offset-4 decoration-white/20 hover:decoration-white/60 transition-colors">black and grey</a>. The choice depends on the old tattoo and your preference.</p>
                </div>
            </div>
        </div>
    </section>`);
    if (index === 12) cards.push(`    <section id="how-it-works" class="md:col-span-2 py-12 px-4 sm:px-6 bg-apple-darkGray/30 rounded-3xl">
        <div class="max-w-[900px] mx-auto">
            <div class="text-center mb-16"><h2 class="text-3xl md:text-4xl font-semibold tracking-tight">Cover-up Process</h2><p class="text-white/40 mt-2">Step by step</p></div>
            <div class="space-y-8">
                <div class="flex gap-6 items-start"><div class="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center font-bold shrink-0">1</div><div><h3 class="text-lg font-semibold mb-1">Photo Assessment</h3><p class="text-white/50 leading-relaxed">Send a clear close-up of the old tattoo and a wider shot showing the whole area, in good natural light. I'll assess the colour, density, and scarring to determine what's possible.</p></div></div>
                <div class="flex gap-6 items-start"><div class="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center font-bold shrink-0">2</div><div><h3 class="text-lg font-semibold mb-1">Honest Feedback</h3><p class="text-white/50 leading-relaxed">I'll explain which designs are realistic for your existing tattoo and which may not work. If the old ink limits your options, you'll know before booking.</p></div></div>
                <div class="flex gap-6 items-start"><div class="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center font-bold shrink-0">3</div><div><h3 class="text-lg font-semibold mb-1">Custom Design</h3><p class="text-white/50 leading-relaxed">The new design is built around the old tattoo's specific characteristics — using its shapes and shadows as a starting point, not working against them. You'll see the design on session day.</p></div></div>
                <div class="flex gap-6 items-start"><div class="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center font-bold shrink-0">4</div><div><h3 class="text-lg font-semibold mb-1">Tattoo &amp; Aftercare</h3><p class="text-white/50 leading-relaxed">Cover-ups usually take a similar amount of time to colour realism, even in black and grey. A touch-up may be needed after full healing and is charged separately. Full <a href="/aftercare/" class="text-white underline underline-offset-4 decoration-white/20 hover:decoration-white/60 transition-colors">aftercare guide</a> provided. I follow up during healing.</p></div></div>
            </div>
        </div>
    </section>`);
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
          <a href="${source}" data-speciality-lightbox data-lightbox-alt="${esc(alt)}" class="group block aspect-[3/4] overflow-hidden" aria-label="Open ${esc(alt)}">
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
