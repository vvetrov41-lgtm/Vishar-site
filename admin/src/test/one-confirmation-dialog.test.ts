// One confirmation dialog, and it stays that way.
//
// A CRM-owned alertdialog was introduced for the eight consequential RPCs and
// recorded as complete. Features added afterwards reached for window.confirm
// again — payments, reconciliation, deposit requirements, time off, project
// cancellation and two deactivation controls — so the product asked for
// confirmation in two visibly different ways, one of them labelled with the
// browser's hostname. The fix was a shared component; this guard is what makes
// it stick, because the previous fix was an RPC interceptor that new call sites
// simply did not go through.

import { describe, expect, it } from 'vitest';

// Vite's own glob rather than node:fs, so the guard needs no extra dependency
// and no Node type declarations to typecheck.
const SOURCES = import.meta.glob('../**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

describe('confirmation consistency', () => {
  it('routes every confirmation through the shared dialog', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !path.includes('/test/'))
      .filter(([path]) => !path.endsWith('lib/confirm-dialog.ts'))
      .filter(([, source]) => /\bwindow\.confirm\s*\(/.test(source))
      .map(([path]) => path);

    expect(
      offenders,
      'use confirmDialog() from lib/confirm-dialog instead of window.confirm'
    ).toEqual([]);
  });

  it('keeps the consequential RPC dialog on the same implementation', () => {
    const source = SOURCES['../lib/consequential-client.ts'];
    expect(source, 'consequential-client.ts was not found by the glob').toBeTruthy();
    expect(source).toContain("from './confirm-dialog'");
    expect(source).toContain('confirmDialog({');
  });
});
