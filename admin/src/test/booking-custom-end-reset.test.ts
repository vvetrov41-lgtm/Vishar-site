import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../components/BookingPanel.tsx', import.meta.url)),
  'utf8',
);

describe('duration shortcut after custom end', () => {
  it('returns the end to automatic calculation', () => {
    const chooseDuration = source.slice(
      source.indexOf('function chooseDuration'),
      source.indexOf('function updateManualStart'),
    );
    expect(chooseDuration).toContain("setManualEndOverride('')");
  });
});
