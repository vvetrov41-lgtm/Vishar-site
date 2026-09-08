/*
 * VISHAR TATTOO — shared site content (single source of truth)
 *
 * Nav, footer, portfolio/gallery cards and portfolio cross-links used to be
 * generated in the browser by components.js and by per-page <script> blocks.
 * That left the raw HTML response empty for crawlers that do not execute
 * JavaScript. This module now owns that markup; scripts/build-static-html.mjs
 * renders it into the committed HTML files, and the browser scripts only
 * attach behaviour to what is already there.
 *
 * Generated artifacts are committed (same pattern as assets/css/tailwind.css)
 * so the Cloudflare Pages deployment keeps serving plain static files.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ── Config (must stay in sync with components.js BOOKING_URL) ── */
export const BOOKING_URL = '/booking/';
const EMAIL = 'info@vishartattoo.com';
const INSTAGRAM = 'https://www.instagram.com/vladimir_vishar';

// Deliberately a constant rather than new Date(): the build must be
// deterministic so CI can diff generated HTML. components.js refreshes the
// rendered value to the live year on load.
const FOOTER_YEAR = 2026;

export const NAV_LINKS = [
  { id: 'home',      label: 'Home',          href: '/' },
  { id: 'booking',   label: 'Book a Tattoo', href: '/booking/' },
  { id: 'about',     label: 'About',         href: '/about/' },
  { id: 'book',      label: 'The Book',      href: '/book/' },
  { id: 'aftercare', label: 'Aftercare',     href: '/aftercare/' },
  { id: 'faq',       label: 'FAQ',           href: '/faq/' },
  { id: 'ai-tools',  label: 'Studio Tools',  href: '/ai-tools/' }
];

export const COLLECTION_LINKS = [
  {
    id: 'colour-realism',
    label: 'Colour Realism',
    href: '/colour-realism-tattoo-london/',
    description: 'Vivid photorealistic colour tattoos and custom compositions.',
    image: '/assets/colour-realism/01.webp',
    alt: 'Colour realism tattoo by Vladimir Vishar'
  },
  {
    id: 'black-grey',
    label: 'Black & Grey',
    href: '/black-and-grey-realism-london/',
    description: 'Black and grey realism with strong tonal structure and depth.',
    image: '/assets/black-grey/08.webp',
    alt: 'Black and grey realism tattoo by Vladimir Vishar London - 8'
  },
  {
    id: 'cover-up',
    label: 'Cover-ups',
    href: '/cover-up-tattoo-london/',
    description: 'Before and after transformations of existing tattoos.',
    image: '/assets/cover-ups/after-01.webp',
    alt: 'Completed cover-up tattoo by Vladimir Vishar'
  },
  {
    id: 'portrait',
    label: 'Portraits',
    href: '/portrait-tattoo-artist-london/',
    description: 'Colour and black-and-grey portrait realism.',
    image: '/assets/portraits/05.webp',
    alt: 'Colour realism Vivienne Westwood portrait tattoo by Vladimir Vishar'
  },
  {
    id: 'large-scale',
    label: 'Large Scale',
    href: '/large-scale-realism-tattoo-london/',
    description: 'Sleeves and multi-session realism projects.',
    image: '/assets/large-scale/02.jpg',
    alt: 'Large-scale black and grey realism arm tattoo by Vladimir Vishar'
  },
  {
    id: 'healed',
    label: 'Fresh vs Healed',
    href: '/healed-tattoos/',
    description: 'Matched fresh and confirmed healed tattoo comparisons.',
    image: '/assets/healed/06.webp',
    alt: 'Confirmed healed black and grey warrior mask portrait tattoo by Vladimir Vishar'
  }
];

const SOCIALS = [
  { label: 'Instagram', href: INSTAGRAM },
  { label: 'YouTube',   href: 'https://youtube.com/@vladimir_vishar' },
  { label: 'TikTok',    href: 'https://www.tiktok.com/@vladimir.vishar' },
  { label: 'Facebook',  href: 'https://www.facebook.com/profile.php?id=100088974927193' }
];

const MOBILE_SOCIALS = [
  {
    label: 'Instagram',
    href: INSTAGRAM,
    icon: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.25"/><circle cx="17.4" cy="6.6" r="1" fill="currentColor" stroke="none"/>'
  },
  {
    label: 'TikTok',
    href: 'https://www.tiktok.com/@vladimir.vishar',
    icon: '<path d="M14.5 4v10.2a4.2 4.2 0 1 1-3.6-4.16v2.82a1.6 1.6 0 1 0 1 1.48V4h2.6Zm0 0c.35 2.05 1.55 3.25 3.5 3.6v2.65A6.45 6.45 0 0 1 14.5 8.9"/>'
  },
  {
    label: 'Facebook',
    href: 'https://www.facebook.com/profile.php?id=100088974927193',
    icon: '<path d="M14.2 8.2h3V4.4c-.52-.07-2.3-.2-4.4-.2-4.1 0-6.9 2.5-6.9 7.1v4H2v4.3h3.9V24h4.8v-4.4h4l.64-4.3h-4.64v-3.58c0-1.25.34-2.1 2.12-2.1h2.38V8.2Z" transform="translate(3 -2) scale(.82)" fill="currentColor" stroke="none"/>'
  },
  {
    label: 'Pinterest',
    href: 'https://uk.pinterest.com/VladimirVisharTatt/',
    icon: '<path d="M12 3.2a8.8 8.8 0 0 0-3.2 17c-.08-1.45-.02-3.2.36-4.83l1.13-4.78s-.28-.58-.28-1.43c0-1.34.77-2.34 1.74-2.34.82 0 1.22.62 1.22 1.36 0 .83-.53 2.06-.8 3.2-.23.96.48 1.75 1.43 1.75 1.72 0 3.04-1.81 3.04-4.43 0-2.32-1.67-3.94-4.05-3.94-2.76 0-4.38 2.07-4.38 4.21 0 .84.32 1.73.72 2.22.08.1.09.18.07.28l-.27 1.1c-.04.18-.14.22-.33.13-1.23-.57-2-2.37-2-3.82 0-3.1 2.25-5.95 6.5-5.95 3.41 0 6.06 2.43 6.06 5.68 0 3.39-2.14 6.12-5.1 6.12-1 0-1.93-.52-2.25-1.13l-.61 2.33c-.22.85-.82 1.92-1.22 2.57.92.28 1.89.43 2.9.43a8.8 8.8 0 1 0 0-17.6Z" fill="currentColor" stroke="none"/>'
  },
  {
    label: 'YouTube',
    href: 'https://youtube.com/@vladimir_vishar',
    icon: '<path d="M21.6 7.2a2.5 2.5 0 0 0-1.76-1.77C18.3 5 12 5 12 5s-6.3 0-7.84.43A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.76 1.77C5.7 19 12 19 12 19s6.3 0 7.84-.43a2.5 2.5 0 0 0 1.76-1.77A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8Z" fill="currentColor" stroke="none"/><path d="m10 15 5.2-3L10 9v6Z" fill="#000" stroke="none"/>'
  },
  {
    label: 'Email',
    href: 'mailto:' + EMAIL,
    icon: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>'
  }
];

/* Matches the browser-side esc(): textContent -> innerHTML escapes &, < and >. */
export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cls(value) {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed ? ` class="${trimmed}"` : '';
}

/* ── Navigation ── */
export function renderNav(pageId) {
  const portfolioActive = COLLECTION_LINKS.some((item) => item.id === pageId);

  const desktopPortfolioLinks = COLLECTION_LINKS
    .map((item) => `        <a href="${item.href}"${cls(item.id === pageId ? 'is-active' : '')}>${esc(item.label)}</a>`)
    .join('\n');

  const mobilePortfolioLinks = COLLECTION_LINKS
    .map((item) => `        <a href="${item.href}" onclick="toggleMenu()"${cls(item.id === pageId ? 'text-apple-blue' : '')}>${esc(item.label)}</a>`)
    .join('\n');

  const desktopLinks = NAV_LINKS.map((l) => {
    const link = `        <a href="${l.href}"${cls('hover:text-white transition-colors ' + (l.id === pageId ? 'text-white' : ''))}>${esc(l.label)}</a>`;
    if (l.id !== 'home') return link;
    return `${link}
        <details id="desktop-portfolio-menu" class="portfolio-desktop-wrap">
          <summary${cls('portfolio-desktop-trigger ' + (portfolioActive ? 'text-white' : ''))}>Portfolio
            <svg class="portfolio-nav-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
          </summary>
          <div class="portfolio-desktop-menu">
${desktopPortfolioLinks}
          </div>
        </details>`;
  }).join('\n');

  const mobileLinks = NAV_LINKS.map((l) => {
    const link = `      <a href="${l.href}" onclick="toggleMenu()"${cls('transition-colors ' + (l.id === pageId ? 'text-apple-blue' : 'hover:text-white/80'))}>${esc(l.label)}</a>`;
    if (l.id !== 'home') return link;
    return `${link}
      <details id="mobile-portfolio-menu"${cls('mobile-portfolio ' + (portfolioActive ? 'is-active' : ''))}>
        <summary class="mobile-portfolio-toggle">Portfolio
          <svg class="mobile-portfolio-chevron" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </summary>
        <div class="mobile-portfolio-links">
${mobilePortfolioLinks}
        </div>
      </details>`;
  }).join('\n');

  const mobileSocialLinks = MOBILE_SOCIALS.map((s) => {
    const isEmail = s.href.indexOf('mailto:') === 0;
    return `        <a href="${s.href}"${isEmail ? '' : ' target="_blank" rel="noopener noreferrer"'}
          class="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 text-white/65 transition-colors hover:border-white/40 hover:text-white focus-visible:border-white focus-visible:text-white"
          aria-label="${esc(s.label)}" title="${esc(s.label)}">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${s.icon}</svg>
        </a>`;
  }).join('\n');

  return `<nav class="fixed top-0 w-full z-[100] glass border-b border-white/10" role="navigation" aria-label="Main">
    <div class="max-w-[1200px] mx-auto px-6 h-14 flex justify-between items-center">
      <a href="/" class="text-lg font-medium tracking-tight hover:opacity-70 transition-opacity">Vladimir Vishar</a>
      <div class="hidden lg:flex space-x-6 text-[12px] font-normal text-white/60 items-center">
${desktopLinks}
      </div>
      <button class="lg:hidden text-white p-2 -mr-2" onclick="toggleMenu()"
              aria-label="Toggle menu" aria-controls="mobile-overlay"
              aria-expanded="false" id="mobile-menu-toggle">
        <svg id="menu-icon-open" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none"
             viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16m-16 6h16" />
        </svg>
        <svg id="menu-icon-close" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 hidden" fill="none"
             viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
    <div id="mobile-overlay"
         class="hidden fixed inset-0 left-0 right-0 top-14 max-w-full box-border overflow-x-hidden overflow-y-auto bg-black/95 backdrop-blur-md z-[90] flex flex-col px-6 pt-10 pb-8 space-y-5 text-xl font-medium"
         aria-hidden="true">
${mobileLinks}
      <div class="mobile-menu-footer pt-4 mt-auto border-t border-white/10">
        <div class="mb-5 flex items-center justify-center gap-1" role="group" aria-label="Social media and email">
${mobileSocialLinks}
        </div>
        <a href="${BOOKING_URL}"
           class="block w-full text-center py-3 bg-white text-black rounded-full font-semibold text-base"
           onclick="toggleMenu()">Start an inquiry</a>
      </div>
    </div>
  </nav>`;
}

/* ── Footer ── */
export function renderFooter() {
  const pageLinks = NAV_LINKS
    .map((l) => `            <a href="${l.href}" class="hover:text-white transition-colors">${esc(l.label)}</a>`)
    .join('\n');

  const collectionLinks = COLLECTION_LINKS
    .map((l) => `            <a href="${l.href}" class="hover:text-white transition-colors">${esc(l.label)}</a>`)
    .join('\n');

  const socialLinks = SOCIALS
    .map((s) => `            <a href="${s.href}" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">${esc(s.label)}</a>`)
    .join('\n');

  return `<footer class="py-20 border-t border-white/5 px-6">
    <div class="max-w-[1200px] mx-auto">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-12 mb-12">
        <div>
          <p class="text-xl font-semibold mb-4">Vladimir Vishar</p>
          <p class="text-sm text-white/60 leading-relaxed">Colour &amp; Black-Grey Realism<br>London enquiries now open</p>
          <p class="text-sm text-white/60 leading-relaxed mt-3">Private studio details are confirmed with each appointment.<br>By appointment only · No walk-ins</p>
          <a href="mailto:${EMAIL}" class="text-sm text-white/60 hover:text-white mt-3 inline-block transition-colors">${EMAIL}</a>
        </div>
        <div>
          <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-4">Pages</p>
          <div class="flex flex-col space-y-2 text-sm text-white/60">
${pageLinks}
          </div>
        </div>
        <div>
          <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-4">Collections</p>
          <div class="flex flex-col space-y-2 text-sm text-white/60">
${collectionLinks}
          </div>
        </div>
        <div>
          <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-4">Social</p>
          <div class="flex flex-col space-y-2 text-sm text-white/60">
${socialLinks}
          </div>
        </div>
      </div>
      <div class="pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4">
        <div class="text-xs text-white/40 uppercase tracking-[0.4em]">
          &copy; <span data-current-year>${FOOTER_YEAR}</span> Vladimir Vishar. All rights reserved.
        </div>
        <div class="flex items-center gap-6">
          <a href="/privacy/" class="text-xs text-white/60 hover:text-white transition-colors">Privacy &amp; Cookies</a>
          <a href="${BOOKING_URL}"
             class="text-xs text-white/60 hover:text-white transition-colors">
            Start an inquiry →
          </a>
        </div>
      </div>
    </div>
  </footer>`;
}

/* ── Portfolio cross-links ("Explore other galleries") ── */
export function renderPortfolioCrosslinks(pageId) {
  const others = COLLECTION_LINKS.filter((item) => item.id !== pageId);

  const cards = others.map((item) => `        <a href="${item.href}" class="rounded-2xl border border-white/10 bg-white/[0.03] p-6 hover:bg-white/[0.07] transition-colors group">
          <h3 class="text-lg font-semibold text-white">${esc(item.label)}</h3>
          <p class="mt-2 text-sm leading-relaxed text-white/50">${esc(item.description)}</p>
          <span class="mt-4 inline-block text-sm text-white/70 group-hover:text-white transition-colors">View gallery →</span>
        </a>`).join('\n');

  return `<section id="portfolio-crosslinks" class="py-20 px-6 border-y border-white/5">
  <div class="max-w-[1200px] mx-auto">
    <div class="text-center mb-10">
      <p class="text-sm uppercase tracking-[0.3em] text-white/30 mb-4">Portfolio</p>
      <h2 class="text-3xl md:text-4xl font-semibold tracking-tight">Explore other galleries</h2>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
${cards}
    </div>
  </div>
</section>`;
}

/* ── Homepage: portfolio collection cards under the main grid ── */
export function renderHomepagePortfolioCollections() {
  const cards = COLLECTION_LINKS.map((item) => `      <a href="${item.href}" class="group overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] transition-colors hover:bg-white/[0.06]">
        <div class="aspect-[16/10] overflow-hidden bg-white/5">
          <img src="${item.image}" alt="${esc(item.alt)}" loading="lazy" decoding="async" class="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105">
        </div>
        <div class="p-5 text-left">
          <h3 class="text-lg font-semibold text-white">${esc(item.label)}</h3>
          <p class="mt-2 text-sm leading-relaxed text-white/50">${esc(item.description)}</p>
          <span class="mt-4 inline-block text-sm text-white/70">View gallery →</span>
        </div>
      </a>`).join('\n');

  return `<div id="portfolio-collections" class="max-w-[1400px] mx-auto mt-10">
  <div class="mb-5 text-center">
    <p class="text-xs uppercase tracking-[0.28em] text-white/60">Portfolio galleries</p>
  </div>
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
${cards}
  </div>
</div>`;
}

/* ── Homepage: approach block ── */
export function renderHomepageApproach() {
  return `<section id="homepage-approach" class="px-6 pb-20">
  <div class="max-w-[1200px] mx-auto grid grid-cols-1 lg:grid-cols-[0.9fr_1.4fr] gap-8 lg:gap-12 items-start">
    <div>
      <p class="text-[10px] uppercase tracking-[0.35em] text-white/30 mb-4">Approach</p>
      <h2 class="text-3xl md:text-5xl font-semibold tracking-tight mb-5">How I approach a project</h2>
      <p class="text-base md:text-lg leading-relaxed text-white/50 max-w-xl">Every piece starts with placement, skin, references, and what the tattoo needs to do on the body. The goal is a custom design that reads clearly now and still holds up over time.</p>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <article class="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
        <p class="mb-4 text-[10px] font-medium uppercase tracking-[0.35em] text-white/35">01</p>
        <h3 class="text-lg font-semibold mb-3">Fit first</h3>
        <p class="text-sm leading-relaxed text-white/60">The design is built around placement, flow, scale, and how the image will sit on the body.</p>
      </article>
      <article class="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
        <p class="mb-4 text-[10px] font-medium uppercase tracking-[0.35em] text-white/35">02</p>
        <h3 class="text-lg font-semibold mb-3">Reference-led</h3>
        <p class="text-sm leading-relaxed text-white/60">Your references set the direction. The final image is adjusted into a custom tattoo design.</p>
      </article>
      <article class="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
        <p class="mb-4 text-[10px] font-medium uppercase tracking-[0.35em] text-white/35">03</p>
        <h3 class="text-lg font-semibold mb-3">Realistic scope</h3>
        <p class="text-sm leading-relaxed text-white/60">Cover-ups, detail level, time estimate, and limitations are assessed before you decide to book.</p>
      </article>
    </div>
  </div>
</section>`;
}
