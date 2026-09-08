import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../components/BookingPanel.tsx', import.meta.url)),
  'utf8',
);

describe('custom end labels', () => {
  it('labels the three deterministic end controls distinctly', () => {
    expect(source).toContain("endDate: 'End date'");
    expect(source).toContain("endHour: 'End hour'");
    expect(source).toContain("endMinute: 'End minute'");
  });
});
