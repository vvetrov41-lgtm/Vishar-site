import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../components/BookingPanel.tsx', import.meta.url)),
  'utf8',
);

describe('custom booking end duration sync', () => {
  it('syncs the displayed duration to a manually chosen end', () => {
    expect(source).toContain('syncDurationToRange(manualStart, value)');
    expect(source).toContain("setManualEndOverride('')");
  });
});
