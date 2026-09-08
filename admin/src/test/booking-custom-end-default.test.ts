import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../components/BookingPanel.tsx', import.meta.url)),
  'utf8',
);

describe('automatic booking end default', () => {
  it('keeps automatic end calculation as the default path', () => {
    expect(source).toContain('const manualEnd = manualEndOverride || automaticManualEnd;');
    expect(source).toContain('appointmentEndValue(manualStart, durationMinutes)');
  });
});
