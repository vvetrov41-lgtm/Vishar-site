import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../components/BookingPanel.tsx', import.meta.url)),
  'utf8',
);

describe('custom booking end copy', () => {
  it('exposes an explicit custom-end action in both languages', () => {
    expect(source).toContain("customEnd: 'Set custom end'");
    expect(source).toContain("customEnd: 'Изменить конец вручную'");
    expect(source).toContain("useDurationEnd: 'Calculate end from duration'");
    expect(source).toContain("useDurationEnd: 'Считать конец по длительности'");
  });
});
