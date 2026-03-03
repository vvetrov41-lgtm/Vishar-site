/* ─────────────────────────────────────────────────────────
VISHAR TATTOO — Shared Components
Single source of truth for nav, footer, mobile CTA
───────────────────────────────────────────────────────── */

(function () {
‘use strict’;

/* ── Config ── */
const BOOKING_URL = ‘https://shorturl.at/orgVK’;
const EMAIL = ‘info@vishartattoo.com’;
const INSTAGRAM = ‘https://www.instagram.com/vladimir_vishar’;

const NAV_LINKS = [
{ id: ‘home’,           label: ‘Home’,           href: ‘/’ },
{ id: ‘colour-realism’, label: ‘Colour Realism’, href: ‘/colour-realism-tattoo-manchester/’ },
{ id: ‘black-grey’,     label: ‘Black & Grey’,   href: ‘/black-and-grey-realism-manchester/’ },
{ id: ‘cover-up’,       label: ‘Cover-ups’,      href: ‘/cover-up-tattoo-manchester/’ },
{ id: ‘about’,          label: ‘About’,           href: ‘/about/’ },
{ id: ‘aftercare’,      label: ‘Aftercare’,       href: ‘/aftercare/’ },
{ id: ‘faq’,            label: ‘FAQ’,              href: ‘/faq/’ },
{ id: ‘ai-tools’,       label: ‘AI Tools’,        href: ‘/ai-tools/’ }
];

const SOCIALS = [
{ label: ‘Instagram’, href: INSTAGRAM },
{ label: ‘YouTube’,   href: ‘https://youtube.com/@vladimir_vishar’ },
{ label: ‘TikTok’,    href: ‘https://www.tiktok.com/@vladimir.vishar’ },
{ label: ‘Facebook’,  href: ‘https://www.facebook.com/profile.php?id=100088974927193’ }
];

const pageId = window.PAGE_ID || ‘’;

/* ── Helpers ── */
function esc(str) {
const d = document.createElement(‘div’);
d.textContent = str;
return d.innerHTML;
}

/* ── Navigation ── */
function buildNav() {
const el = document.getElementById(‘site-nav’);
if (!el) return;

```
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
           onclick="toggleMenu()">Book Your Session</a>
      </div>
    </div>
  </nav>`;
```

}

/* ── Footer ── */
function buildFooter() {
const el = document.getElementById(‘site-footer’);
if (!el) return;

```
const pageLinks = NAV_LINKS.map(l =>
  `<a href="${l.href}" class="hover:text-white transition-colors">${esc(l.label)}</a>`
).join('\n');

const socialLinks = SOCIALS.map(s =>
  `<a href="${s.href}" target="_blank" rel="noopener noreferrer" class="hover:text-white transition-colors">${esc(s.label)}</a>`
).join('\n');

el.innerHTML = `
  <footer class="py-20 border-t border-white/5 px-6">
    <div class="max-w-[1200px] mx-auto">
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
          Book a session →
        </a>
      </div>
    </div>
  </footer>`;
```

}

/* ── Sticky Mobile CTA ── */
function buildStickyCta() {
const el = document.getElementById(‘sticky-cta’);
if (!el) return;

```
const text = el.dataset.ctaText || 'Book Your Session — from £140/hr';
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
```

}

/* ── Mobile Menu Toggle ── */
window.toggleMenu = function () {
const overlay = document.getElementById(‘mobile-overlay’);
const toggle = document.getElementById(‘mobile-menu-toggle’);
const iconOpen = document.getElementById(‘menu-icon-open’);
const iconClose = document.getElementById(‘menu-icon-close’);
if (!overlay) return;

```
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
```

};

/* ── Keyboard: Escape to close overlays ── */
document.addEventListener(‘keydown’, function (e) {
if (e.key !== ‘Escape’) return;

```
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
```

});

/* ── Scroll-reveal (IntersectionObserver) ── */
function initReveal() {
const els = document.querySelectorAll(’.reveal’);
if (!els.length) return;

```
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
```

}

/* ── Init ── */
document.addEventListener(‘DOMContentLoaded’, function () {
buildNav();
buildFooter();
buildStickyCta();
initReveal();
});
})();