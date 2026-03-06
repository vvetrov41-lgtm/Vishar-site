(function () {
  'use strict';

  const slots = [
    '01','02','03','04','05','06','07','08','09','10',
    '11','12','13','14','15','16','17','18','19','20'
  ];

  const candidatePaths = (id) => [
    `/assets/black-grey/${id}.jpg`,
    `/assets/black-grey/${id}.JPG`,
    `/assets/black-grey/${id}.jpeg`,
    `/assets/black-grey/${id}.JPEG`,
    `/assets/black-grey/${id}.jpg.JPG`,
    `/assets/portfolio/${id}.jpg`
  ];

  const images = [];
  let lbIndex = 0;

  function probe(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(src);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function resolveFirstExisting(id) {
    const candidates = candidatePaths(id);
    for (const src of candidates) {
      const ok = await probe(src);
      if (ok) return ok;
    }
    return null;
  }

  function openLightbox(i) {
    lbIndex = i;
    updateLightbox();
    const lb = document.getElementById('lightbox');
    lb.classList.remove('hidden');
    lb.setAttribute('data-open', 'true');
    lb.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lightbox-active');
  }

  window.closeLightbox = function () {
    const lb = document.getElementById('lightbox');
    lb.classList.add('hidden');
    lb.removeAttribute('data-open');
    lb.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lightbox-active');
  };

  window.navLb = function (delta) {
    if (!images.length) return;
    lbIndex = (lbIndex + delta + images.length) % images.length;
    updateLightbox();
  };

  function updateLightbox() {
    if (!images.length) return;
    const img = document.getElementById('lightbox-img');
    img.src = images[lbIndex].src;
    img.alt = images[lbIndex].alt;
    document.getElementById('lb-counter').textContent = `${lbIndex + 1} / ${images.length}`;
  }

  window.onLbClick = function (e) {
    const lb = document.getElementById('lightbox');
    const lbImg = document.getElementById('lightbox-img');
    if (e.target === lb || e.target === lbImg) window.closeLightbox();
  };

  function bindGestures() {
    let startX = 0;
    const lb = document.getElementById('lightbox');
    lb.addEventListener('touchstart', (e) => { startX = e.changedTouches[0].screenX; }, { passive: true });
    lb.addEventListener('touchend', (e) => {
      const d = e.changedTouches[0].screenX - startX;
      if (Math.abs(d) > 50) window.navLb(d > 0 ? -1 : 1);
    }, { passive: true });
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      const lb = document.getElementById('lightbox');
      if (lb.classList.contains('hidden')) return;
      if (e.key === 'ArrowRight') window.navLb(1);
      if (e.key === 'ArrowLeft') window.navLb(-1);
    });
  }

  window.toggleFaq = function (btn) {
    const item = btn.parentElement;
    const wasActive = item.classList.contains('active');
    document.querySelectorAll('.faq-item').forEach((el) => {
      el.classList.remove('active');
      el.querySelector('button').setAttribute('aria-expanded', 'false');
    });
    if (!wasActive) {
      item.classList.add('active');
      btn.setAttribute('aria-expanded', 'true');
    }
  };

  function renderEmptyState(grid) {
    const box = document.createElement('div');
    box.className = 'col-span-full rounded-2xl border border-white/10 bg-white/5 p-8 text-center text-white/50';
    box.textContent = 'Gallery is updating. Please check back shortly.';
    grid.appendChild(box);
  }

  async function buildGallery() {
    const grid = document.getElementById('bg-gallery-grid');
    if (!grid) return;

    for (const id of slots) {
      const src = await resolveFirstExisting(id);
      if (!src) continue;

      const idx = images.length;
      const alt = `Black and grey realism tattoo by Vladimir Vishar Manchester – ${idx + 1}`;
      images.push({ src, alt });

      const card = document.createElement('div');
      card.className = 'aspect-[3/4] overflow-hidden bg-apple-darkGray cursor-zoom-in group relative';
      card.addEventListener('click', () => openLightbox(idx));
      card.innerHTML = `<img src="${src}" loading="lazy" decoding="async" width="900" height="1200" alt="${alt}" class="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105"><div class="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"><span class="text-xs uppercase tracking-widest font-semibold">View</span></div>`;
      grid.appendChild(card);
    }

    if (!images.length) renderEmptyState(grid);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await buildGallery();
    bindGestures();
    bindKeyboard();
  });
})();
