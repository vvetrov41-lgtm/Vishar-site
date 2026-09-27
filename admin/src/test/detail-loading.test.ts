import { describe, expect, it } from 'vitest';
import { isBlockingDetailLoad } from '../lib/detail-loading';

describe('isBlockingDetailLoad', () => {
  it('blocks the first load of a record', () => {
    expect(isBlockingDetailLoad(true, undefined, 'p1')).toBe(true);
    expect(isBlockingDetailLoad(true, null, 'p1')).toBe(true);
  });

  it('keeps the page mounted while the same record reloads after an action', () => {
    // Regression: creating a deposit link reloaded the project page, the
    // loader unmounted ProjectDepositPanel and the new link vanished.
    expect(isBlockingDetailLoad(true, 'p1', 'p1')).toBe(false);
  });

  it('blocks when navigating to a different record', () => {
    expect(isBlockingDetailLoad(true, 'p1', 'p2')).toBe(true);
  });

  it('never blocks once loading finished', () => {
    expect(isBlockingDetailLoad(false, undefined, 'p1')).toBe(false);
  });
});
