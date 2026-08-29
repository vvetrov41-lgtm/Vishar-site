(function () {
  'use strict';

  const MAX_IMAGES = 24;
  const WIDTHS = [320, 480, 720, 960];
  const CONFIG = {
    'large-scale': {
      base: '/assets/large-scale/',
      genericAlt: 'Large-scale realism tattoo by Vladimir Vishar, London',
    },
    portrait: {
      base: '/assets/portraits/',
      genericAlt: 'Realism portrait tattoo by Vladimir Vishar, London',
    },
    healed: {
      base: '/assets/healed/',
      genericAlt: 'Confirmed healed realism tattoo by Vladimir Vishar',
    },
  };

  function pad(number) {
    return String(number).padStart(2, '0');
  }

  async function exists(url) {
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function loadMetadata(base) {
    try {
      const response = await fetch(base + 'metadata.json', { cache: 'no-store' });
      if (!response.ok) return {};
      const data = await response.json();
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  async function discoverImages(base) {
    const images = [];
    for (let number = 1; number <= MAX_IMAGES; number += 1) {
      const stem = pad(number);
      const source = base + stem + '.jpg';
      const found = await exists(source);
      if (!found) break;
      images.push({ stem, source });
    }
    return images;
  }

  function pictureMarkup(config, image, metadata, index) {
    const info = metadata[image.stem] || {};
    const alt = info.alt || `${config.genericAlt} - image ${index + 1}`;
    const caption = info.caption || info.healed_for || '';
    const srcset = WIDTHS.map((width) => `${config.base}thumbs/${image.stem}-${width}.webp ${width}w`).join(', ');

    return `
      <figure class="overflow-hidden bg-white/5 rounded-2xl">
        <a href="${image.source}" target="_blank" rel="noopener" class="group block aspect-[3/4] overflow-hidden" aria-label="Open image ${index + 1}">
          <picture>
            <source type="image/webp" srcset="${srcset}" sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw">
            <img src="${image.source}" loading="lazy" decoding="async" width="900" height="1200" alt="${escapeHtml(alt)}" class="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105">
          </picture>
        </a>
        ${caption ? `<figcaption class="p-4 text-sm text-white/50">${escapeHtml(caption)}</figcaption>` : ''}
      </figure>`;
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
  }

  async function buildGallery() {
    const section = document.querySelector('[data-speciality-gallery]');
    if (!section) return;

    const key = section.getAttribute('data-speciality-gallery');
    const config = CONFIG[key];
    if (!config) return;

    const grid = section.querySelector('[data-speciality-gallery-grid]');
    if (!grid) return;

    const [images, metadata] = await Promise.all([
      discoverImages(config.base),
      loadMetadata(config.base),
    ]);

    if (!images.length) return;

    grid.innerHTML = images.map((image, index) => pictureMarkup(config, image, metadata, index)).join('');
    section.classList.remove('hidden');
    section.removeAttribute('aria-hidden');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildGallery, { once: true });
  } else {
    buildGallery();
  }
})();
