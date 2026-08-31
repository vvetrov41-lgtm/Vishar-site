import { describe, expect, it } from 'vitest';

const sources = import.meta.glob([
  '../pages/**/*.tsx',
  '../components/**/*.tsx',
], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const BRAND_ONLY = new Set([
  'CRM',
  'Gmail',
  'Google Calendar',
  'Instagram',
  'Monzo',
  'OAuth',
  'Telegram',
  'Vishar',
  'Vishar CRM',
  'WhatsApp',
]);

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function operatorFacingRawEnglish(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const found = new Set<string>();

  // Plain JSX text nodes bypass useLanguage()/COPY and therefore cannot react
  // to the Russian language setting. Expressions are deliberately excluded:
  // customer names, messages and other stored data must stay verbatim.
  for (const match of withoutComments.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
    const text = normalise(match[1]);
    if (text && !BRAND_ONLY.has(text)) found.add(text);
  }

  // The same rule applies to accessibility/help copy that is written directly
  // as a string prop. Styling, routes, input values and machine identifiers are
  // intentionally not scanned.
  for (const match of withoutComments.matchAll(/\b(?:aria-label|placeholder|title|alt)=["']([^"']*[A-Za-z][^"']*)["']/g)) {
    const text = normalise(match[1]);
    if (text && !BRAND_ONLY.has(text)) found.add(text);
  }

  return [...found].sort();
}

describe('operator-facing localisation boundary', () => {
  it('does not hard-code English UI copy in pages or shared components', () => {
    const failures = Object.entries(sources)
      .flatMap(([path, source]) => operatorFacingRawEnglish(source).map((text) => `${path}: ${text}`));

    expect(failures, failures.join('\n')).toEqual([]);
  });
});
