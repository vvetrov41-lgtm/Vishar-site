/* ─────────────────────────────────────────────────────────
VISHAR TATTOO — Shared Components

Progressive enhancement only. Nav, footer, portfolio grids and portfolio
cross-links are rendered into the static HTML at build time from
scripts/lib/site-content.mjs (see scripts/build-static-html.mjs), so they are
present in the raw response before any JavaScript runs. This file attaches
behaviour to that markup, and owns the sticky CTA, analytics/consent, and the
shared accessibility wiring.
───────────────────────────────────────────────────────── */

(function () {
'use strict';

/* ── Config ── */
const BOOKING_URL = '/booking/';
// Single source of truth for availability. Change only this line; HTML uses a neutral fallback.
const BOOKING_WINDOW = 'London bookings now open';
const AI_WORKER_URL = 'https://tattooai.vvetrov41.workers.dev/';

const GA_MEASUREMENT_ID = 'G-2LLK879TRG';
const CONSENT_KEY = 'vishar-cookie-consent';

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
  .replace(/Book a session/g, 'Send your concept')
  .replace(/Book Now/g, 'Send your concept')
  .replace(/Starts at £140/g, '£140/hr')
  .replace(/Get a Free Quote/g, 'Send your concept');
}

function populateBookingWindow() {
  document.querySelectorAll('[data-booking-window]').forEach(function (el) {
    el.textContent = BOOKING_WINDOW;
  });
}

/* ── Navigation ──
   The nav markup itself is rendered into the HTML at build time by
   scripts/build-static-html.mjs, so the links exist without JavaScript.
   The only thing left to do here is lift the mobile overlay out of the nav
   and onto <body>, which the fixed-position overlay and the inert handling
   in setMobileMenuBackgroundInert() both rely on. */
function enhanceNav() {
const el = document.getElementById('site-nav');
if (!el) return;

const overlay = el.querySelector('#mobile-overlay');
if (overlay && overlay.parentElement !== document.body) {
  document.body.appendChild(overlay);
}
}

function initPortfolioNavigation() {
  const desktopPortfolio = document.getElementById('desktop-portfolio-menu');
  if (desktopPortfolio) {
    document.addEventListener('click', function (event) {
      if (desktopPortfolio.open && !desktopPortfolio.contains(event.target)) {
        desktopPortfolio.removeAttribute('open');
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !desktopPortfolio.open) return;
      desktopPortfolio.removeAttribute('open');
      const summary = desktopPortfolio.querySelector('summary');
      if (summary) summary.focus();
    });
  }
}

/* ── Footer ──
   The footer is rendered into the HTML at build time. Its copyright year is
   emitted as a fixed value so the build stays deterministic, so refresh it
   here to the year the visitor is actually in. */
function refreshFooterYear() {
const year = String(new Date().getFullYear());
document.querySelectorAll('[data-current-year]').forEach(function (el) {
  if (el.textContent !== year) el.textContent = year;
});
}

/* ── Booking video orbs ── */
function setupBookingCircleVideo() {
  const buttons = Array.from(document.querySelectorAll('main a[href="' + BOOKING_URL + '"]')).filter(function (button) {
    if (button.querySelector('.booking-orb-media')) return false;
    if (button.closest('#sticky-cta, #site-footer, #site-nav, nav')) return false;

    const className = button.className || '';
    const isEndPageCircle = !!button.closest('#contact, #book') &&
      className.indexOf('rounded-full') !== -1 &&
      className.indexOf('w-64') !== -1 &&
      className.indexOf('h-64') !== -1;

    return isEndPageCircle;
  });

  if (!buttons.length) return;

  const prefersRM = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const shouldLoadVideo = !prefersRM && !(conn && (conn.saveData || /^(2g|slow-2g)$/i.test(conn.effectiveType || '')));

  buttons.forEach(function (button) {
    button.classList.add('booking-video-orb');

    const media = document.createElement('span');
    media.className = 'booking-orb-media';
    media.setAttribute('aria-hidden', 'true');
    media.innerHTML = `
      <video class="booking-orb-video" muted loop playsinline preload="none" tabindex="-1" disablepictureinpicture disableremoteplayback></video>
      <span class="booking-orb-shade"></span>`;
    button.insertBefore(media, button.firstChild);

    Array.from(button.children).forEach(function (child) {
      if (child !== media) child.classList.add('booking-orb-content');
    });

    const video = media.querySelector('video');
    if (!video || !shouldLoadVideo || !('IntersectionObserver' in window)) return;

    let loaded = false;
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || loaded) return;
        loaded = true;
        observer.disconnect();

        const source = document.createElement('source');
        source.src = '/assets/brand/logo-video.mp4';
        source.type = 'video/mp4';
        video.appendChild(source);
        video.load();

        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(function () { /* autoplay blocked: keep static orb */ });
        }

        const reveal = function () { button.classList.add('video-ready'); };
        video.addEventListener('canplay', reveal, { once: true });
        window.setTimeout(reveal, 4000);
      });
    }, { rootMargin: '0px 0px 360px 0px', threshold: 0.01 });

    observer.observe(button);
  });
}

/* ── AI idea lead capture ── */
function setupAiIdeaLeadCapture() {
if (pageId !== 'home') return;

const ideaInput = document.getElementById('ai-idea-input');
const ideaResult = document.getElementById('ai-idea-res');
if (!ideaInput || !ideaResult || document.getElementById('ai-idea-lead')) return;

const leadBox = document.createElement('div');
leadBox.id = 'ai-idea-lead';
leadBox.className = 'mt-4 hidden rounded-2xl border border-violet-300/15 bg-violet-300/[0.06] p-5';
leadBox.innerHTML = `
  <p class="text-sm font-medium text-white mb-2">Send this idea to Vladimir?</p>
  <p class="text-xs leading-relaxed text-white/60 mb-4">Add your contact details and this tattoo idea will be sent directly to Vladimir.</p>
  <div class="grid gap-3 md:grid-cols-2">
    <label class="block">
      <span class="mb-1 block text-xs uppercase tracking-[0.25em] text-white/60">Name</span>
      <input id="ai-idea-name" type="text" autocomplete="name" placeholder="Your name" class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/25 outline-none transition-colors focus:border-white/40">
    </label>
    <label class="block">
      <span class="mb-1 block text-xs uppercase tracking-[0.25em] text-white/60">Contact</span>
      <input id="ai-idea-contact" type="text" autocomplete="email" placeholder="Email, WhatsApp or Instagram" class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-white/25 outline-none transition-colors focus:border-white/40">
    </label>
  </div>
  <label class="mt-3 block">
    <span class="mb-1 block text-xs uppercase tracking-[0.25em] text-white/60">Preferred reply</span>
    <select id="ai-idea-reply" class="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none transition-colors focus:border-white/40">
      <option>Email</option>
      <option>WhatsApp</option>
      <option>Instagram</option>
      <option>No preference</option>
    </select>
  </label>
  <p class="mt-3 text-xs leading-relaxed text-white/60">I’ll use this only to reply about your tattoo idea.</p>
  <button type="button" id="ai-idea-send-btn" class="mt-4 w-full rounded-full border border-violet-300/20 bg-violet-400/20 px-5 py-3 text-sm font-semibold text-white transition-all hover:bg-violet-400/30 active:scale-95">Send this idea to Vladimir</button>
  <p id="ai-idea-send-status" class="mt-3 hidden text-xs leading-relaxed text-white/50"></p>
`;
ideaResult.insertAdjacentElement('afterend', leadBox);

const sendButton = leadBox.querySelector('#ai-idea-send-btn');
const status = leadBox.querySelector('#ai-idea-send-status');
const defaultButtonText = sendButton ? sendButton.textContent : 'Send this idea to Vladimir';

function setStatus(message, isError) {
  if (!status) return;
  status.textContent = message;
  status.classList.remove('hidden', 'text-red-200', 'text-white/50');
  status.classList.add(isError ? 'text-red-200' : 'text-white/50');
}

window.sendIdeaToVladimir = async function () {
  const originalIdea = ideaInput.value.trim();
  const aiSummary = ideaResult.innerText.trim();
  const name = (document.getElementById('ai-idea-name') || {}).value || '';
  const contact = (document.getElementById('ai-idea-contact') || {}).value || '';
  const preferredReply = (document.getElementById('ai-idea-reply') || {}).value || 'No preference';

  if (!contact.trim()) {
    setStatus('Please add an email, WhatsApp number or Instagram username first.', true);
    return;
  }

  if (sendButton) {
    sendButton.disabled = true;
    sendButton.textContent = 'Sending...';
  }
  setStatus('Sending to Vladimir...', false);

  try {
    const response = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'lead',
        name: name.trim(),
        contact: contact.trim(),
        preferredReply,
        originalIdea,
        aiSummary,
        page: window.location.href
      })
    });

    const data = await response.json().catch(function () { return {}; });

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || 'Lead request failed.');
    }

    setStatus('Sent. Vladimir will review your idea.', false);
    if (sendButton) sendButton.textContent = 'Sent';
  } catch (error) {
    setStatus('Sorry, something went wrong. Please email info@vishartattoo.com', true);
    if (sendButton) {
      sendButton.disabled = false;
      sendButton.textContent = defaultButtonText;
    }
  }
};

if (sendButton) {
  sendButton.addEventListener('click', window.sendIdeaToVladimir);
}

const originalAiIdea = window.aiIdea;
if (typeof originalAiIdea === 'function') {
  window.aiIdea = async function () {
    leadBox.classList.add('hidden');
    if (status) status.classList.add('hidden');
    if (sendButton) {
      sendButton.disabled = false;
      sendButton.textContent = defaultButtonText;
    }
    await originalAiIdea.apply(this, arguments);
    const resultText = ideaResult.innerText.trim();
    if (resultText && !ideaResult.classList.contains('hidden')) {
      leadBox.classList.remove('hidden');
    }
  };
}

}

/* ── Sticky Mobile CTA ── */
function buildStickyCta() {
const el = document.getElementById('sticky-cta');
if (!el) return;

document.body.classList.add('has-sticky-cta');

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

/* ── Analytics (GA4, Google Consent Mode v2) ──
   The dataLayer/gtag stub and the consent default must exist before anything
   else runs, so the "denied" signal is in place before the GA4 tag itself
   is ever requested. This is an analytics-only setup: ad_storage,
   ad_user_data and ad_personalization stay permanently denied and are never
   updated anywhere in this file. */
window.dataLayer = window.dataLayer || [];
window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
window.gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  wait_for_update: 500
});

function loadAnalytics() {
if (document.getElementById('ga4-script')) return; // already loaded — never queue a second config

window.gtag('js', new Date());
window.gtag('config', GA_MEASUREMENT_ID, {
  allow_google_signals: false,
  allow_ad_personalization_signals: false
});

const s = document.createElement('script');
s.id = 'ga4-script';
s.async = true;
s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
document.head.appendChild(s);
}

function grantAnalyticsConsent() {
window.gtag('consent', 'update', { analytics_storage: 'granted' });
loadAnalytics();
}

function denyAnalyticsConsent() {
window.gtag('consent', 'update', { analytics_storage: 'denied' });
}

function getConsent() {
try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
}

function setConsent(value) {
try { localStorage.setItem(CONSENT_KEY, value); } catch (e) { /* private browsing: banner will just reappear */ }
}

/* ── Cookie consent banner ── */
function buildConsentBanner() {
const stored = getConsent();
if (stored === 'granted') { grantAnalyticsConsent(); return; }
if (stored === 'denied') { denyAnalyticsConsent(); return; }
if (document.getElementById('cookie-consent')) return;

const banner = document.createElement('div');
banner.id = 'cookie-consent';
banner.setAttribute('role', 'region');
banner.setAttribute('aria-label', 'Cookie consent');
banner.className = 'fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:bottom-6 md:max-w-sm z-[200] rounded-2xl border border-white/10 bg-black/90 backdrop-blur-md p-5 shadow-2xl';
banner.innerHTML = `
  <p class="text-sm leading-relaxed text-white/60 mb-4">This site uses optional analytics cookies to see which pages are useful. Nothing is set unless you accept. <a href="/privacy/" class="text-white/80 underline underline-offset-4 decoration-white/30 hover:text-white transition-colors">Privacy &amp; cookies</a></p>
  <div class="flex gap-3">
    <button type="button" id="cookie-accept" class="flex-1 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition-all hover:bg-white/90 active:scale-95">Accept</button>
    <button type="button" id="cookie-decline" class="flex-1 rounded-full border border-white/15 px-4 py-2.5 text-sm font-medium text-white/70 transition-colors hover:text-white hover:border-white/30">Decline</button>
  </div>`;
document.body.appendChild(banner);

banner.querySelector('#cookie-accept').addEventListener('click', function () {
  setConsent('granted');
  banner.remove();
  grantAnalyticsConsent();
});
banner.querySelector('#cookie-decline').addEventListener('click', function () {
  setConsent('denied');
  banner.remove();
  denyAnalyticsConsent();
});
}

/* Re-open the banner from the privacy page ("Manage cookie preferences"). */
window.visharManageCookies = function () {
try { localStorage.removeItem(CONSENT_KEY); } catch (e) {}
const existing = document.getElementById('cookie-consent');
if (existing) existing.remove();
buildConsentBanner();
};

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
    return el.querySelector('a[href="' + BOOKING_URL + '"]') && el.querySelector('a[href="#portfolio"]');
  });
  if (ctaRow) ctaRow.classList.add('homepage-hero-cta-row');
}

const processTexts = [
  'You send your idea',
  'I review the project',
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

/* ── Service Feature Cards ── */
function refineServiceFeatureCards() {
const serviceCards = {
  'colour-realism': ['True-to-Life Colour', 'Light & Shadow', 'Custom Composition'],
  'black-grey': ['Full Tonal Range', 'Dramatic Contrast', 'Ages Gracefully'],
  'cover-up': ['Free Assessment', 'Strategic Design', 'Complete Concealment']
};

const titles = serviceCards[pageId];
if (!titles) return;

titles.forEach(function (title) {
  const heading = Array.from(document.querySelectorAll('main h3')).find(function (el) {
    return el.textContent.trim() === title;
  });
  if (!heading) return;

  const card = heading.closest('.card-lift') || heading.closest('div');
  if (!card) return;

  card.classList.remove('text-center');
  card.classList.add('text-left');

  card.querySelectorAll('.text-center').forEach(function (el) {
    el.classList.remove('text-center');
    el.classList.add('text-left');
  });

  const previous = heading.previousElementSibling;
  const previousText = previous ? previous.textContent.trim() : '';
  const emojiMarkers = ['🎨', '💡', '✦', '🖤', '🌑', '⏳', '📸', '🧩'];

  if (
    previous &&
    previous.classList.contains('text-3xl') &&
    emojiMarkers.includes(previousText)
  ) {
    previous.remove();
  }
});

}

/* ── Mobile Menu Toggle ── */
function setMobileMenuBackgroundInert(overlay, makeInert) {
  const siteNav = document.getElementById('site-nav');
  Array.from(document.body.children).forEach(function (el) {
    if (el === overlay || el === siteNav) return;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') return;
    if (makeInert) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  });
}

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

if (iconOpen) iconOpen.classList.toggle('hidden', isOpen);
if (iconClose) iconClose.classList.toggle('hidden', !isOpen);

document.body.classList.toggle('lightbox-active', isOpen);
setMobileMenuBackgroundInert(overlay, isOpen);

if (isOpen) {
  const firstLink = overlay.querySelector('a');
  if (firstLink) firstLink.focus();
} else {
  const portfolioMenu = document.getElementById('mobile-portfolio-menu');
  if (portfolioMenu) portfolioMenu.removeAttribute('open');
  if (toggle) toggle.focus();
}

};

function initMobileMenuA11y() {
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;

    const overlay = document.getElementById('mobile-overlay');
    if (!overlay || overlay.classList.contains('hidden')) return;

    const focusables = Array.from(overlay.querySelectorAll('a[href], summary, button:not([disabled])')).filter(function (el) {
      return el.offsetParent !== null;
    });
    if (!focusables.length) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (e.shiftKey) {
      if (active === first || !overlay.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !overlay.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  });
}

/* ── Shared Lightbox Zoom ── */
window.initLightboxZoom = function () {
const lb = document.getElementById('lightbox');
const img = document.getElementById('lightbox-img');
if (!lb || !img || img.dataset.zoomBound === 'true') return;

function setZoom(isZoomed) {
  img.style.transform = isZoomed ? 'scale(2)' : 'scale(1)';
  img.style.cursor = isZoomed ? 'zoom-out' : 'zoom-in';
  img.dataset.zoomed = isZoomed ? 'true' : 'false';
}

window.resetLightboxZoom = function () { setZoom(false); };
window.toggleLightboxZoom = function () { setZoom(img.dataset.zoomed !== 'true'); };

setZoom(false);
img.addEventListener('click', function (e) {
  e.stopPropagation();
  window.toggleLightboxZoom();
});
img.dataset.zoomBound = 'true';
};

/* ── Shared FAQ accordion accessibility wiring ── */
function initFaqA11y() {
document.querySelectorAll('.faq-item').forEach(function (item, i) {
  const btn = item.querySelector('button');
  const panel = item.querySelector('.faq-content');
  if (!btn || !panel) return;

  if (!btn.id) btn.id = 'faq-toggle-' + i;
  if (!panel.id) panel.id = 'faq-panel-' + i;
  btn.setAttribute('aria-controls', panel.id);
  panel.setAttribute('aria-labelledby', btn.id);
});
}

/* ── Shared Lightbox accessibility (close button, focus trap, focus restore) ── */
function initLightboxA11y() {
const lb = document.getElementById('lightbox');
if (!lb || lb.dataset.a11yBound === 'true') return;
lb.dataset.a11yBound = 'true';

if (!lb.getAttribute('aria-label')) lb.setAttribute('aria-label', 'Portfolio image preview');

if (!document.getElementById('vishar-lightbox-a11y-styles')) {
  const style = document.createElement('style');
  style.id = 'vishar-lightbox-a11y-styles';
  style.textContent = [
    '.lb-close{position:absolute;top:16px;right:16px;width:48px;height:48px;display:none;align-items:center;justify-content:center;border-radius:50%;background:rgba(255,255,255,.08);color:rgba(255,255,255,.85);border:1px solid rgba(255,255,255,.12);cursor:pointer;transition:all .25s ease;z-index:20;backdrop-filter:blur(12px)}',
    '#lightbox[data-open="true"] .lb-close{display:flex}',
    '.lb-close:hover{background:rgba(255,255,255,.15);color:#fff}',
    '@media (max-width:768px){.lb-close{top:8px;right:8px}}',
    '@media print{.lb-close{display:none!important}}'
  ].join('');
  document.head.appendChild(style);
}

const closeBtn = document.createElement('button');
closeBtn.type = 'button';
closeBtn.className = 'lb-close';
closeBtn.setAttribute('aria-label', 'Close image preview');
closeBtn.innerHTML = '<svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18L18 6M6 6l12 12"/></svg>';
closeBtn.addEventListener('click', function () {
  if (typeof window.closeLightbox === 'function') window.closeLightbox();
});
lb.appendChild(closeBtn);

let lastFocused = null;

function setBackgroundInert(makeInert) {
  Array.from(document.body.children).forEach(function (el) {
    if (el === lb) return;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') return;
    if (makeInert) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  });
}

function onOpen() {
  lastFocused = document.activeElement;
  setBackgroundInert(true);
  closeBtn.focus();
}

function onClose() {
  setBackgroundInert(false);
  if (lastFocused && lastFocused.isConnected && typeof lastFocused.focus === 'function') {
    lastFocused.focus();
  }
  lastFocused = null;
}

let wasOpen = lb.getAttribute('aria-hidden') === 'false';
const observer = new MutationObserver(function () {
  const isOpen = lb.getAttribute('aria-hidden') === 'false';
  if (isOpen === wasOpen) return;
  wasOpen = isOpen;
  if (isOpen) onOpen();
  else onClose();
});
observer.observe(lb, { attributes: true, attributeFilter: ['aria-hidden'] });

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Tab' || lb.classList.contains('hidden')) return;

  const focusables = Array.from(lb.querySelectorAll('button')).filter(function (el) {
    return el.offsetParent !== null;
  });
  if (!focusables.length) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  if (e.shiftKey) {
    if (active === first || !lb.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !lb.contains(active)) {
    e.preventDefault();
    first.focus();
  }
});
}

/* ── Keyboard: Escape to close overlays ── */
document.addEventListener('keydown', function (e) {
if (e.key !== 'Escape') return;

const lb = document.getElementById('lightbox');
if (lb && !lb.classList.contains('hidden')) {
  if (typeof window.closeLightbox === 'function') window.closeLightbox();
  return;
}

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
    '.portfolio-desktop-wrap{position:relative}',
    '.portfolio-desktop-trigger{display:flex;align-items:center;gap:4px;list-style:none;cursor:pointer;transition:color .2s ease}',
    '.portfolio-desktop-trigger::-webkit-details-marker{display:none}',
    '.portfolio-nav-chevron{transition:transform .2s ease}',
    '.portfolio-desktop-wrap[open] .portfolio-nav-chevron{transform:rotate(180deg)}',
    '.portfolio-desktop-menu{position:absolute;top:calc(100% + 14px);left:50%;transform:translateX(-50%);min-width:230px;padding:8px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:rgba(18,18,20,.96);box-shadow:0 18px 50px rgba(0,0,0,.45);backdrop-filter:blur(20px);z-index:130}',
    '.portfolio-desktop-menu a{display:block;padding:10px 12px;border-radius:10px;color:rgba(255,255,255,.68);white-space:nowrap;transition:background .2s ease,color .2s ease}',
    '.portfolio-desktop-menu a:hover,.portfolio-desktop-menu a:focus-visible,.portfolio-desktop-menu a.is-active{background:rgba(255,255,255,.08);color:#fff}',
    '#mobile-overlay.hidden{display:none!important}',
    '#mobile-overlay{position:fixed!important;left:0!important;right:0!important;top:3.5rem!important;bottom:0!important;z-index:999!important;display:flex!important;flex-direction:column!important;padding:1.75rem!important;padding-top:2rem!important;gap:.95rem!important;overflow-y:auto!important;background:linear-gradient(180deg,rgba(10,10,12,.48),rgba(0,0,0,.30))!important;-webkit-backdrop-filter:blur(8px) saturate(110%)!important;backdrop-filter:blur(8px) saturate(110%)!important}',
    '#mobile-overlay a{position:relative!important;z-index:1!important;text-shadow:0 2px 12px rgba(0,0,0,.45)!important}',
    '#mobile-overlay>a,#mobile-overlay>.mobile-portfolio>.mobile-portfolio-toggle{font-size:clamp(1.55rem,7vw,2.25rem)!important;line-height:1.12!important;font-weight:560!important;color:rgba(255,255,255,.94)!important;text-decoration:none!important}',
    '#mobile-overlay>a.text-apple-blue,#mobile-overlay>.mobile-portfolio.is-active>.mobile-portfolio-toggle{color:#0a84ff!important}',
    '#mobile-overlay>.mobile-portfolio{margin:0!important;margin-top:1.25rem!important;padding:0!important;border:0!important}',
    '.mobile-portfolio-toggle{display:flex!important;align-items:center!important;justify-content:space-between!important;list-style:none!important;cursor:pointer!important}',
    '.mobile-portfolio-toggle::-webkit-details-marker{display:none}',
    '.mobile-portfolio-chevron{transition:transform .2s ease}',
    '.mobile-portfolio[open] .mobile-portfolio-chevron{transform:rotate(180deg)}',
    '.mobile-portfolio-links{display:grid!important;gap:.55rem!important;padding:.8rem 0 .25rem 1rem!important}',
    '.mobile-portfolio-links a{font-size:1rem!important;line-height:1.3!important;font-weight:500!important;color:rgba(255,255,255,.62)!important;text-decoration:none!important}',
    '.mobile-portfolio-links a.text-apple-blue{color:#0a84ff!important}',
    '#mobile-overlay>.mobile-menu-footer{margin-top:auto!important;padding-top:1.25rem!important;border-top:1px solid rgba(255,255,255,.14)!important}',
    '#mobile-overlay>.mobile-menu-footer>a{display:block!important;width:100%!important;border-radius:9999px!important;background:rgba(255,255,255,.92)!important;color:#000!important;text-align:center!important;padding:.9rem 1.15rem!important;font-size:1rem!important;font-weight:650!important;text-shadow:none!important}',
    'body.lightbox-active{overflow:hidden!important;touch-action:none!important}',
    '.booking-video-orb{position:relative!important;overflow:hidden!important;background:#050505!important;color:#fff!important}',
    '.booking-video-orb:hover,.booking-video-orb:focus-visible{background:#050505!important;color:#fff!important}',
    '.booking-video-orb .booking-orb-media{position:absolute!important;inset:0!important;z-index:0!important;border-radius:inherit!important;overflow:hidden!important;pointer-events:none!important;background:radial-gradient(circle at 50% 50%,rgba(255,255,255,.08),rgba(255,255,255,.02) 48%,rgba(0,0,0,.8) 100%)!important}',
    '.booking-video-orb .booking-orb-video{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;display:block!important;object-fit:cover!important;opacity:0!important;transform:scale(1.16)!important;filter:brightness(1.12) contrast(1.05)!important;transition:opacity .7s ease!important}',
    '.booking-video-orb.video-ready .booking-orb-video{opacity:.82!important}',
    '.booking-video-orb .booking-orb-shade{position:absolute!important;inset:0!important;background:radial-gradient(circle at 50% 46%,rgba(0,0,0,.08),rgba(0,0,0,.38) 72%),linear-gradient(180deg,rgba(0,0,0,.22),rgba(0,0,0,.44))!important}',
    '.booking-video-orb .booking-orb-content{position:relative!important;z-index:1!important;text-shadow:0 2px 18px rgba(0,0,0,.55)!important}',
    '@media (max-width:768px){body.has-sticky-cta #site-footer footer{padding-bottom:calc(9rem + env(safe-area-inset-bottom))!important}}',
    '@media (prefers-reduced-motion:reduce){.booking-video-orb .booking-orb-video{display:none!important}}'
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
    const opacity = 1 - p * 0.14;

    hero.style.transform = 'translate3d(0,' + translate + 'px,0)';
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
enhanceNav();
initPortfolioNavigation();
refreshFooterYear();
setupBookingCircleVideo();
setupAiIdeaLeadCapture();
buildStickyCta();
buildConsentBanner();
populateBookingWindow();
refineHomepageTabletLayout();
refineServiceFeatureCards();
injectMotionStyles();
applyRevealToSections();
initHeroParallax();
initReveal();
initFaqA11y();
initLightboxA11y();
initMobileMenuA11y();
});
})();
