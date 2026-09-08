import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../components/BookingPanel.tsx', import.meta.url)),
  'utf8',
);

describe('booking custom range', () => {
  it('builds the booking from the effective manual end', () => {
    expect(source).toContain('const end = new Date(manualEnd);');
    expect(source).toContain('return { start: start.toISOString(), end: end.toISOString() };');
  });
});
