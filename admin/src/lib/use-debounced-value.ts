import { useEffect, useState } from 'react';

export const SEARCH_DEBOUNCE_MS = 300;

/**
 * Keeps the controlled input responsive while delaying work that depends on
 * the value. A pending update is cancelled whenever the value changes again.
 */
export function useDebouncedValue<T>(value: T, delay = SEARCH_DEBOUNCE_MS): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    if (Object.is(value, debouncedValue)) return;

    const timeout = window.setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => window.clearTimeout(timeout);
  }, [debouncedValue, delay, value]);

  return debouncedValue;
}
