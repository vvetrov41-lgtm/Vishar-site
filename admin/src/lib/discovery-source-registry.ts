import registry from '../../../config/discovery-sources.json';

type DiscoveryLanguage = 'en' | 'ru';

type DiscoverySourceDefinition = (typeof registry.sources)[number];

const sourceByKey = new Map<string, DiscoverySourceDefinition>(
  registry.sources.map((source) => [source.key, source]),
);

const legacyAliases: Record<string, string> = registry.legacyAliases;

export const DISCOVERY_SOURCE_KEYS = registry.sources.map((source) => source.key);

export function normalizeDiscoverySource(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  return legacyAliases[raw] ?? raw;
}

function humanizeUnknownKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function discoverySourceLabel(key: string, language: DiscoveryLanguage): string {
  if (key === 'not_recorded') {
    return language === 'ru' ? 'Не указано' : 'Not recorded';
  }

  const source = sourceByKey.get(key);
  if (source) {
    return language === 'ru' ? source.labels.ru : source.labels.en;
  }

  return humanizeUnknownKey(key);
}
