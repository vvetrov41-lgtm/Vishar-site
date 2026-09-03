(function () {
  'use strict';

  const MAX_IMAGES = 32;
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

  function galleryState(config, metadata) {
    const stems = Object.keys(metadata)
      .filter((key) => /^\d{2}$/.test(key))
      .sort()
      .slice(0, MAX_IMAGES);

    const manifest = metadata._gallery && typeof metadata._gallery === 'object'
      ? metadata._gallery
      : {};
    const thumbnailWidths = Array.isArray(manifest.thumbnailWidths)
      ? manifest.thumbnailWidths
        .filter((width) => WIDTHS.includes(width))
        .sort((a, b) => a - b)
      : [];
    const sourceExtension = typeof manifest.sourceExtension === 'string'
      && /^\.(?:jpe?g|webp|png)$/i.test(manifest.sourceExtension)
      ? manifest.sourceExtension.toLowerCase()
      : '.jpg';

    return {
      images: stems.map((stem) => ({ stem, source: `${config.base}${stem}${sourceExtension}` })),
      thumbnailWidths,
    };
  }

  function imageMarkup(config, image, metadata, index, thumbnailWidths) {
    const info = metadata[image.stem] || {};
    const alt = info.alt || `${config.genericAlt} - image ${index + 1}`;
    const caption = info.caption || info.healed_for || '';
    const imageTag = `<img src="${image.source}" loading="lazy" decoding="async" width="900" height="1200" alt="${escapeHtml(alt)}" class="w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105">`;

    let media = imageTag;
    if (thumbnailWidths.length) {
      const srcset = thumbnailWidths.map((width) => `${config.base}thumbs/${image.stem}-${width}.webp ${width}w`).join(', ');
      media = `<picture><source type="image/webp" srcset="${srcset}" sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw">${imageTag}</picture>`;
    }

    return `
      <figure class="overflow-hidden bg-white/5 rounded-2xl">
        <a href="${image.source}" target="_blank" rel="noopener" class="group block aspect-[3/4] overflow-hidden" aria-label="Open image ${index + 1}">
          ${media}
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

    const metadata = await loadMetadata(config.base);
    const { images, thumbnailWidths } = galleryState(config, metadata);

    if (!images.length) return;

    grid.innerHTML = images
      .map((image, index) => imageMarkup(config, image, metadata, index, thumbnailWidths))
      .join('');
    section.classList.remove('hidden');
    section.removeAttribute('aria-hidden');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildGallery, { once: true });
  } else {
    buildGallery();
  }
})();
