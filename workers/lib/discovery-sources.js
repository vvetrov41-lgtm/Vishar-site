import registry from '../../config/discovery-sources.json' with { type: 'json' };

export const DISCOVERY_SOURCE_DEFINITIONS = Object.freeze(
  registry.sources.map((source) => Object.freeze(source))
);

export const DISCOVERY_SOURCE_KEYS = Object.freeze(
  DISCOVERY_SOURCE_DEFINITIONS.map((source) => source.key)
);

export const LEGACY_DISCOVERY_SOURCE_ALIASES = Object.freeze({
  ...registry.legacyAliases,
});

export const DISCOVERY_SOURCE_ACCEPTED_KEYS = new Set([
  ...DISCOVERY_SOURCE_KEYS,
  ...Object.keys(LEGACY_DISCOVERY_SOURCE_ALIASES),
]);

const canonicalByKey = new Map(
  DISCOVERY_SOURCE_DEFINITIONS.map((source) => [source.key, source])
);

function canonicalKey(value) {
  return LEGACY_DISCOVERY_SOURCE_ALIASES[value] || value;
}

export const DISCOVERY_SOURCE_DETAIL_KEYS = new Set(
  [...DISCOVERY_SOURCE_ACCEPTED_KEYS].filter((key) => {
    const source = canonicalByKey.get(canonicalKey(key));
    return source && source.detail.mode !== 'none';
  })
);

export const DISCOVERY_SOURCE_REQUIRED_DETAIL_KEYS = new Set(
  [...DISCOVERY_SOURCE_ACCEPTED_KEYS].filter((key) => {
    const source = canonicalByKey.get(canonicalKey(key));
    return source && source.detail.mode === 'required';
  })
);

export function normalizeDiscoverySource(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  return canonicalKey(key);
}

export function discoverySourceDefinition(value) {
  return canonicalByKey.get(normalizeDiscoverySource(value)) || null;
}

export function discoverySourceDetailLabel(source, artistName, language = 'en') {
  if (!source || source.detail.mode === 'none') return '';
  const template = language === 'ru' ? source.detail.label_ru : source.detail.label_en;
  return String(template || '').replaceAll('{artist}', artistName || 'the artist');
}

export function renderDiscoverySourceOptionsHtml(artistName, escapeHtml) {
  return DISCOVERY_SOURCE_DEFINITIONS.map((source) => {
    const detailLabel = discoverySourceDetailLabel(source, artistName, 'en');
    return [
      '<option value="', escapeHtml(source.key),
      '" data-detail-mode="', escapeHtml(source.detail.mode),
      '" data-detail-label="', escapeHtml(detailLabel),
      '">', escapeHtml(source.labels.en), '</option>',
    ].join('');
  }).join('');
}
