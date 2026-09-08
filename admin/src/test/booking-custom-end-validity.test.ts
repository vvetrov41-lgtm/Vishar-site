import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../components/BookingPanel.tsx', import.meta.url)),
  'utf8',
);

describe('custom booking range validation', () => {
  it('keeps end-after-start validation in the manual flow', () => {
    expect(source).toContain('end <= start');
    expect(source).toContain("endAfterStart: 'End time must be after the start time.'");
  });
});
