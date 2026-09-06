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

  function responsiveMedia(source, srcsetBase, stem, alt, thumbnailWidths, sizes, fit) {
    const style = fit === 'contain' ? ' style="object-fit:contain;background:#000"' : '';
    const imageTag = `<img src="${source}" loading="lazy" decoding="async" width="900" height="1200" alt="${escapeHtml(alt)}" class="w-full h-full transition-transform duration-1000 group-hover:scale-105"${style}>`;

    if (!thumbnailWidths.length) return imageTag;

    const srcset = thumbnailWidths
      .map((width) => `${srcsetBase}${stem}-${width}.webp ${width}w`)
      .join(', ');
    return `<picture><source type="image/webp" srcset="${srcset}" sizes="${sizes}">${imageTag}</picture>`;
  }

  function imageMarkup(config, image, metadata, index, thumbnailWidths) {
    const info = metadata[image.stem] || {};
    const alt = info.alt || `${config.genericAlt} - image ${index + 1}`;
    const caption = info.caption || info.healed_for || '';
    const media = responsiveMedia(
      image.source,
      `${config.base}thumbs/`,
      image.stem,
      alt,
      thumbnailWidths,
      '(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw',
      'cover',
    );

    return `
      <figure class="overflow-hidden bg-white/5 rounded-2xl">
        <a href="${image.source}" target="_blank" rel="noopener" class="group block aspect-[3/4] overflow-hidden" aria-label="Open ${escapeHtml(alt)}">
          ${media}
        </a>
        ${caption ? `<figcaption class="p-4 text-sm text-white/50">${escapeHtml(caption)}</figcaption>` : ''}
      </figure>`;
  }

  function healedPairMarkup(config, image, metadata, index, thumbnailWidths) {
    const info = metadata[image.stem] || {};
    const healedAlt = info.alt || `${config.genericAlt} - image ${index + 1}`;
    const subject = healedAlt
      .replace(/^Confirmed healed\s+/i, '')
      .replace(/\s+by Vladimir Vishar$/i, '');
    const freshAlt = `Fresh-session ${subject} by Vladimir Vishar`;
    const freshSource = `${config.base}fresh/${image.stem}.webp`;

    // Pair 05 received a replacement healed source. The previous responsive set
    // was truncated in transit, so bypass those files and cache-bust the verified source.
    const useVerifiedHealedSource = config.base === '/assets/healed/' && image.stem === '05';
    const healedSource = useVerifiedHealedSource
      ? `${image.source}?v=20260906c`
      : image.source;
    const healedThumbnailWidths = useVerifiedHealedSource ? [] : thumbnailWidths;

    const freshMedia = responsiveMedia(
      freshSource,
      `${config.base}fresh/thumbs/`,
      image.stem,
      freshAlt,
      thumbnailWidths,
      '(min-width: 768px) 25vw, 50vw',
      'contain',
    );
    const healedMedia = responsiveMedia(
      healedSource,
      `${config.base}thumbs/`,
      image.stem,
      healedAlt,
      healedThumbnailWidths,
      '(min-width: 768px) 25vw, 50vw',
      'contain',
    );

    return `
      <figure class="overflow-hidden bg-white/5 rounded-2xl border border-white/10">
        <div class="grid grid-cols-2 gap-2 p-2">
          <div>
            <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">Fresh</p>
            <a href="${freshSource}" target="_blank" rel="noopener" class="group block aspect-[3/4] overflow-hidden rounded-2xl bg-black" aria-label="Open ${escapeHtml(freshAlt)}">
              ${freshMedia}
            </a>
          </div>
          <div>
            <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">Healed</p>
            <a href="${healedSource}" target="_blank" rel="noopener" class="group block aspect-[3/4] overflow-hidden rounded-2xl bg-black" aria-label="Open ${escapeHtml(healedAlt)}">
              ${healedMedia}
            </a>
          </div>
        </div>
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

    const markup = key === 'healed'
      ? images.map((image, index) => healedPairMarkup(config, image, metadata, index, thumbnailWidths))
      : images.map((image, index) => imageMarkup(config, image, metadata, index, thumbnailWidths));

    grid.innerHTML = markup.join('');
    section.classList.remove('hidden');
    section.removeAttribute('aria-hidden');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildGallery, { once: true });
  } else {
    buildGallery();
  }
})();
