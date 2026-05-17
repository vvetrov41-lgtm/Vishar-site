/* ─────────────────────────────────────────────────────────
VISHAR TATTOO — Shared Components
Single source of truth for nav, footer, mobile CTA
───────────────────────────────────────────────────────── */

(function () {
'use strict';

/* ── Config ── */
const BOOKING_URL = 'https://shorturl.at/orgVK';
const EMAIL = 'info@vishartattoo.com';
const INSTAGRAM = 'https://www.instagram.com/vladimir_vishar';

const NAV_LINKS = [
{ id: 'home',           label: 'Home',           href: '/' },
{ id: 'colour-realism', label: 'Colour Realism', href: '/colour-realism-tattoo-manchester/' },
{ id: 'black-grey',     label: 'Black & Grey',   href: '/black-and-grey-realism-manchester/' },
{ id: 'cover-up',       label: 'Cover-ups',      href: '/cover-up-tattoo-manchester/' },
{ id: 'about',          label: 'About',           href: '/about/' },
{ id: 'aftercare',      label: 'Aftercare',       href: '/aftercare/' },
{ id: 'faq',            label: 'FAQ',              href: '/faq/' },
{ id: 'ai-tools',       label: 'AI Tools',        href: '/ai-tools/' }
];

const SOCIALS = [
{ label: 'Instagram', href: INSTAGRAM },
{ label: 'YouTube',   href: 'https://youtube.com/@vladimir_vishar' },
{ label: 'TikTok',    href: 'https://www.tiktok.com/@vladimir.vishar' },
{ label: 'Facebook',  href: 'https://www.facebook.com/profile.php?id=100088974927193' }
];

const pageId = window.PAGE_ID || '';

/* ── Helpers ── */
function esc(str) {
const d = document.createElement('div');
d.textContent = str;
return d.innerHTML;
}

function normaliseCtaText(text) {
if (!text) return 'Send your concept — from £140/hr';
return text
  .replace(/Book Your Session\s*[—-]\s*from £140\/hr/g, 'Send your concept — from £140/hr')
  .replace(/Book Your Session/g, 'Send your concept')
  .replace(/Book a session/g, 'Send your concept');
}

/* ── Navigation ── */
function buildNav() {
const el = document.getElementById('site-nav');
if (!el) return;

const desktopLinks = NAV_LINKS.map(l => {
  const active = l.id === pageId;
  return `<a href="${l.href}" class="hover:text-white transition-colors ${active ? 'text-white' : ''}">${esc(l.label)}</a>`;
}).join('\n');

const mobileLinks = NAV_LINKS.map(l => {
  const active = l.id === pageId;
  return `<a href="${l.href}" onclick="toggleMenu()" class="transition-colors ${active ? 'text-apple-blue' : 'hover:text-white/80'}">${esc(l.label)}</a>`;
}).join('\n');

el.innerHTML = `
  <nav class="fixed top-0 w-full z-[100] glass border-b border-white/10" role="navigation" aria-label="Main">
    <div class="max-w-[1200px] mx-auto px-6 h-14 flex justify-between items-center">
      <a href="/" class="text-lg font-medium tracking-tight hover:opacity-70 transition-opacity">Vladimir Vishar</a>
      <div class="hidden lg:flex space-x-6 text-[12px] font-normal text-white/60">
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
         class="hidden fixed inset-0 top-14 bg-black/95 backdrop-blur-md z-[90] flex flex-col p-8 pt-10 space-y-5 text-xl font-medium"
         aria-hidden="true">
      ${mobileLinks}
      <div class="pt-4 mt-auto border-t border-white/10">
        <a href="${BOOKING_URL}" target="_blank" rel="noopener noreferrer"
           class="block w-full text-center py-3 bg-white text-black rounded-full font-semibold text-base"
           onclick="toggleMenu()">Start an inquiry</a>
      </div>
    </div>
  </nav>`;

const overlay = el.querySelector('#mobile-overlay');
if (overlay && overlay.parentElement !== document.body) {
  document.body.appendChild(overlay);
}

}

/* ── Footer ── */
function buildFooter() {
const el = document.getElementById('site-footer');
if (!el) return;

const pageLinks = NAV_LINKS.map(l =>
  `<a href="${l.href}" class="hover:text-white transition-colors">${esc(l.label)}</a>`
).join('\n');

const socialLinks = SOCIALS.map(s =>
  `<a href="${s.href}" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">${esc(s.label)}</a>`
).join('\n');

el.innerHTML = `
  <footer class="relative overflow-hidden py-20 border-t border-white/5 px-6" style="background:linear-gradient(180deg,#0a0a0d 0%,#050507 60%,#000 100%)">
    <div aria-hidden="true" class="absolute inset-0 z-0 pointer-events-none">
      <video id="footer-video" class="absolute inset-0 w-full h-full object-cover" muted loop playsinline preload="none" aria-hidden="true" tabindex="-1" disablepictureinpicture disableremoteplayback style="opacity:0;transition:opacity .7s ease"></video>
      <div class="absolute inset-0" style="background:linear-gradient(180deg,rgba(0,0,0,0.65) 0%,rgba(0,0,0,0.4) 45%,rgba(0,0,0,0.65) 100%)"></div>
    </div>
    <div class="relative z-10 max-w-[1200px] mx-auto">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-12 mb-12">
        <div>
          <p class="text-xl font-semibold mb-4">Vladimir Vishar</p>
          <p class="text-sm text-white/30 leading-relaxed">Colour &amp; Black-Grey Realism<br>Manchester &amp; Salford</p>
          <a href="mailto:${EMAIL}" class="text-sm text-white/50 hover:text-white mt-3 inline-block transition-colors">${EMAIL}</a>
        </div>
        <div>
          <p class="text-[10px] uppercase tracking-[0.3em] text-white/30 mb-4">Pages</p>
          <div class="flex flex-col space-y-2 text-sm text-white/40">
            ${pageLinks}
          </div>
        </div>
        <div>
          <p class="text-[10px] uppercase tracking-[0.3em] text-white/30 mb-4">Social</p>
          <div class="flex flex-col space-y-2 text-sm text-white/40">
            ${socialLinks}
          </div>
        </div>
      </div>
      <div class="pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4">
        <div class="text-[10px] text-white/20 uppercase tracking-[0.4em]">
          &copy; ${new Date().getFullYear()} Vladimir Vishar. All rights reserved.
        </div>
        <a href="${BOOKING_URL}" target="_blank" rel="noopener noreferrer"
           class="text-xs text-white/40 hover:text-white transition-colors">
          Start an inquiry →
        </a>
      </div>
    </div>
  </footer>`;

}

/* ── Footer video (lazy via IntersectionObserver) ── */
function setupFooterVideo() {
  if (!('IntersectionObserver' in window)) return;
  const footer = document.getElementById('site-footer');
  if (!footer) return;
  const video = footer.querySelector('#footer-video');
  if (!video) return;

  const prefersRM = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersRM) return;

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    if (conn.saveData) return;
    if (/^(2g|slow-2g)$/i.test(conn.effectiveType || '')) return;
  }

  let loaded = false;
  const observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting || loaded) return;
      loaded = true;
      observer.disconnect();

      const source = document.createElement('source');
      source.src = '/Logo_video.MP4';
      source.type = 'video/mp4';
      video.appendChild(source);
      video.load();

      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function () { /* autoplay blocked: keep static gradient */ });
      }

      const reveal = function () { video.style.opacity = '1'; };
      video.addEventListener('canplay', reveal, { once: true });
      window.setTimeout(reveal, 4000);
    });
  }, { rootMargin: '0px 0px 400px 0px', threshold: 0.01 });

  observer.observe(footer);
}

/* ── Sticky Mobile CTA ── */
function buildStickyCta() {
const el = document.getElementById('sticky-cta');
if (!el) return;

const text = normaliseCtaText(el.dataset.ctaText || 'Send your concept — from £140/hr');
el.className = 'sticky-cta hidden-cta';
el.innerHTML = `<a href="${BOOKING_URL}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

let ticking = false;
const threshold = 600;

window.addEventListener('scroll', function () {
  if (!ticking) {
    window.requestAnimationFrame(function () {
      if (window.scrollY > threshold) {
        el.classList.remove('hidden-cta');
      } else {
        el.classList.add('hidden-cta');
      }
      ticking = false;
    });
    ticking = true;
  }
}, { passive: true });

}

/* ── Homepage Tablet Layout ── */
function refineHomepageTabletLayout() {
if (pageId !== 'home') return;

const hero = document.querySelector('main > header');
if (hero) {
  hero.classList.add('homepage-hero');

  const title = hero.querySelector('h1');
  if (title) title.classList.add('homepage-hero-title');

  const heroFlexRows = Array.from(hero.querySelectorAll('.flex'));
  const ctaRow = heroFlexRows.find(function (el) {
    return el.querySelector('a[href="https://shorturl.at/orgVK"]') && el.querySelector('a[href="#portfolio"]');
  });
  if (ctaRow) ctaRow.classList.add('homepage-hero-cta-row');
}

const processTexts = [
  'You send your idea',
  'A tattoo consultant gets back to you',
  'We meet for a consultation',
  'You choose whether to book'
];
const processGrid = Array.from(document.querySelectorAll('main .grid')).find(function (grid) {
  const text = grid.textContent || '';
  return processTexts.every(function (item) { return text.indexOf(item) !== -1; });
});
if (processGrid) processGrid.classList.add('homepage-process-grid');

if (document.getElementById('homepage-tablet-layout-styles')) return;

const style = document.createElement('style');
style.id = 'homepage-tablet-layout-styles';
style.textContent = [
  '@media (min-width: 768px) and (max-width: 1279px){',
  '.homepage-hero-title{font-size:clamp(3.75rem,7vw,4.5rem)!important;line-height:1.02!important;}',
  '.homepage-hero .max-w-4xl{max-width:48rem!important;}',
  '.homepage-hero-cta-row{flex-direction:column!important;align-items:center!important;justify-content:center!important;gap:.75rem!important;}',
  '.homepage-hero-cta-row>a[href="#portfolio"]{padding-top:.25rem!important;padding-bottom:.25rem!important;}',
  '.homepage-process-grid{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;}',
  '}',
  '@media (min-width: 1280px){',
  '.homepage-process-grid{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;}',
  '}'
].join('');

document.head.appendChild(style);

}

/* ── Homepage Specialities Cards ── */
function refineHomepageSpecialitiesCards() {
if (pageId !== 'home') return;

const cards = [
  { title: 'Colour Realism', marker: '01', snippet: 'Portraits, wildlife, florals.' },
  { title: 'Black & Grey', marker: '02', snippet: 'Contrast and shading.' },
  { title: 'Cover-ups', marker: '03', snippet: 'Old ink into something' }
];

cards.forEach(function (item) {
  const heading = Array.from(document.querySelectorAll('main h2, main h3, main h4')).find(function (el) {
    return el.textContent.trim() === item.title;
  });
  if (!heading) return;

  let card = heading.parentElement;
  while (card && card !== document.body) {
    const text = card.textContent || '';
    if (text.indexOf(item.snippet) !== -1) break;
    card = card.parentElement;
  }
  if (!card || card === document.body) card = heading.parentElement;

  card.classList.remove('text-center');
  card.classList.add('text-left');

  card.querySelectorAll('.text-center').forEach(function (el) {
    el.classList.remove('text-center');
    el.classList.add('text-left');
  });

  if (heading.previousElementSibling && heading.previousElementSibling.classList.contains('speciality-marker')) return;

  const marker = document.createElement('p');
  marker.className = 'speciality-marker mb-4 text-[10px] font-medium uppercase tracking-[0.35em] text-white/35';
  marker.textContent = item.marker;
  heading.parentNode.insertBefore(marker, heading);
});

}

/* ── Homepage Approach Block ── */
function addHomepageApproachBlock() {
if (pageId !== 'home' || document.getElementById('homepage-approach')) return;

const aboutHeading = Array.from(document.querySelectorAll('main h2, main h3')).find(function (el) {
  return el.textContent.trim() === 'Precision in Every Needle.';
});
if (!aboutHeading) return;

const aboutSection = aboutHeading.closest('section, article, div');
if (!aboutSection || !aboutSection.parentNode) return;

const section = document.createElement('section');
section.id = 'homepage-approach';
section.className = 'px-6 pb-20';
section.innerHTML = `
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
        <p class="text-sm leading-relaxed text-white/45">The design is built around placement, flow, scale, and how the image will sit on the body.</p>
      </article>
      <article class="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
        <p class="mb-4 text-[10px] font-medium uppercase tracking-[0.35em] text-white/35">02</p>
        <h3 class="text-lg font-semibold mb-3">Reference-led</h3>
        <p class="text-sm leading-relaxed text-white/45">Your references set the direction. The final image is adjusted into a custom tattoo design.</p>
      </article>
      <article class="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
        <p class="mb-4 text-[10px] font-medium uppercase tracking-[0.35em] text-white/35">03</p>
        <h3 class="text-lg font-semibold mb-3">Realistic scope</h3>
        <p class="text-sm leading-relaxed text-white/45">Cover-ups, detail level, time estimate, and limitations are assessed before you decide to book.</p>
      </article>
    </div>
  </div>`;

aboutSection.parentNode.insertBefore(section, aboutSection.nextSibling);

}

/* ── Homepage Booking Window ── */
function updateHomepageBookingWindow() {
if (pageId !== 'home') return;

const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
const replacements = [
  ['booking Jul–Aug 2026', 'booking Sep–Oct 2026'],
  ['booking Jul-Aug 2026', 'booking Sep-Oct 2026'],
  ['booking July-August 2026', 'booking September-October 2026']
];

while (walker.nextNode()) {
  let text = walker.currentNode.nodeValue;
  replacements.forEach(function (pair) {
    text = text.split(pair[0]).join(pair[1]);
  });
  walker.currentNode.nodeValue = text;
}

}

/* ── Mobile Menu Toggle ── */
window.toggleMenu = function () {
const overlay = document.getElementById('mobile-overlay');
const toggle = document.getElementById('mobile-menu-toggle');
const iconOpen = document.getElementById('menu-icon-open');
const iconClose = document.getElementById('menu-icon-close');
if (!overlay) return;

const isHidden = overlay.classList.contains('hidden');

overlay.classList.toggle('hidden');
if (isHidden) overlay.classList.add('mobile-overlay-enter');
else overlay.classList.remove('mobile-overlay-enter');

const isOpen = !overlay.classList.contains('hidden');
overlay.setAttribute('aria-hidden', String(!isOpen));
if (toggle) toggle.setAttribute('aria-expanded', String(isOpen));

// Swap hamburger ↔ X icon
if (iconOpen) iconOpen.classList.toggle('hidden', isOpen);
if (iconClose) iconClose.classList.toggle('hidden', !isOpen);

document.body.classList.toggle('lightbox-active', isOpen);

};

/* ── Keyboard: Escape to close overlays ── */
document.addEventListener('keydown', function (e) {
if (e.key !== 'Escape') return;

// Lightbox first
const lb = document.getElementById('lightbox');
if (lb && !lb.classList.contains('hidden')) {
  if (typeof window.closeLightbox === 'function') window.closeLightbox();
  return;
}

// Mobile menu
const overlay = document.getElementById('mobile-overlay');
if (overlay && !overlay.classList.contains('hidden')) {
  window.toggleMenu();
}

});

/* ── Global motion polish ── */
function injectMotionStyles() {
  if (document.getElementById('vishar-motion-styles')) return;

  const style = document.createElement('style');
  style.id = 'vishar-motion-styles';
  style.textContent = [
    '.reveal{opacity:1;transform:none;filter:none;transition:opacity .9s cubic-bezier(.22,1,.36,1),transform .9s cubic-bezier(.22,1,.36,1),filter .9s cubic-bezier(.22,1,.36,1)}',
    '.motion-ready .reveal{opacity:0;transform:translate3d(0,28px,0) scale(.985);filter:blur(6px) brightness(.72)}',
    '.motion-ready .reveal.visible{opacity:1;transform:translate3d(0,0,0) scale(1);filter:blur(0) brightness(1)}',
    '.hero-parallax{will-change:transform,opacity;transform-origin:center top}',
    '#mobile-overlay.hidden{display:none!important}',
    '#mobile-overlay{position:fixed!important;left:0!important;right:0!important;top:3.5rem!important;bottom:0!important;z-index:999!important;display:flex!important;flex-direction:column!important;padding:1.75rem!important;padding-top:2rem!important;gap:.95rem!important;overflow-y:auto!important;background:linear-gradient(180deg,rgba(10,10,12,.48),rgba(0,0,0,.30))!important;-webkit-backdrop-filter:blur(8px) saturate(110%)!important;backdrop-filter:blur(8px) saturate(110%)!important}',
    '#mobile-overlay a{position:relative!important;z-index:1!important;text-shadow:0 2px 12px rgba(0,0,0,.45)!important}',
    '#mobile-overlay>a{font-size:clamp(1.55rem,7vw,2.25rem)!important;line-height:1.12!important;font-weight:560!important;color:rgba(255,255,255,.94)!important;text-decoration:none!important}',
    '#mobile-overlay>a.text-apple-blue{color:#0a84ff!important}',
    '#mobile-overlay>div{margin-top:auto!important;padding-top:1.25rem!important;border-top:1px solid rgba(255,255,255,.14)!important}',
    '#mobile-overlay>div>a{display:block!important;width:100%!important;border-radius:9999px!important;background:rgba(255,255,255,.92)!important;color:#000!important;text-align:center!important;padding:.9rem 1.15rem!important;font-size:1rem!important;font-weight:650!important;text-shadow:none!important}',
    'body.lightbox-active{overflow:hidden!important;touch-action:none!important}'
  ].join('');

  document.head.appendChild(style);
}

function applyRevealToSections() {
  document.documentElement.classList.add('motion-ready');
  const blocks = document.querySelectorAll('main section, main article');
  if (!blocks.length) return;

  blocks.forEach(function (el, i) {
    if (!el.classList.contains('reveal')) el.classList.add('reveal');
    el.style.transitionDelay = Math.min(i * 40, 240) + 'ms';
  });
}

function initHeroParallax() {
  const hero = document.querySelector('main > header');
  if (!hero) return;

  hero.classList.add('hero-parallax');

  let ticking = false;
  function update() {
    const y = Math.max(window.scrollY, 0);
    const p = Math.min(y / 700, 1);
    const translate = p * 24;
    const scale = 1 + p * 0.03;
    const opacity = 1 - p * 0.14;

    hero.style.transform = 'translate3d(0,' + translate + 'px,0) scale(' + scale.toFixed(3) + ')';
    hero.style.opacity = opacity.toFixed(3);
    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      window.requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });
}

/* ── Scroll-reveal (IntersectionObserver) ── */
function initReveal() {
const els = document.querySelectorAll('.reveal');
if (!els.length) return;

if (!('IntersectionObserver' in window)) {
  // Fallback: show everything
  els.forEach(function (el) { el.classList.add('visible'); });
  return;
}

const observer = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

els.forEach(function (el) { observer.observe(el); });

  // Failsafe for mobile/older browsers where observer callbacks can be delayed.
  window.setTimeout(function () {
    document.querySelectorAll('.reveal:not(.visible)').forEach(function (el) {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 1.2) {
        el.classList.add('visible');
      }
    });
  }, 1200);

}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', function () {
buildNav();
buildFooter();
setupFooterVideo();
buildStickyCta();
refineHomepageTabletLayout();
refineHomepageSpecialitiesCards();
addHomepageApproachBlock();
updateHomepageBookingWindow();
injectMotionStyles();
applyRevealToSections();
initHeroParallax();
initReveal();
});
})();
