// A small hook for "load something, show loading/error/empty properly".
//
// Written by hand rather than pulled in as a data-fetching dependency: the
// application has one consumer shape and a handful of screens.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reloadScrollY = useRef<number | null>(null);

  const reload = useCallback(() => {
    // Explicit reloads update the record in place. Remember the viewport before
    // the action swaps controls out of the DOM, and release button/select focus
    // so Safari does not scroll to the replacement focus target.
    if (typeof window !== 'undefined') reloadScrollY.current = window.scrollY;
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    loader()
      .then((result) => { if (!cancelled) setData(result); })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'Could not load that.');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);

        const scrollY = reloadScrollY.current;
        if (scrollY === null || typeof window === 'undefined') return;
        reloadScrollY.current = null;
        window.requestAnimationFrame(() => {
          window.scrollTo({ top: scrollY, left: 0, behavior: 'auto' });
        });
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}
