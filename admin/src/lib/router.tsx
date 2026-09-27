// A minimal hash router.
//
// Ordinary CRM navigation stays hash-based so it works on any static host
// without server rewrite rules. Supabase OAuth is the one bounded exception:
// its authorization server redirects the browser to the configured consent UI
// as a normal pathname, so that exact owned path must reach the consent page.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

export interface Route {
  path: string;
  params: Record<string, string>;
}

export type NavigationKind = 'initial' | 'push' | 'pop' | 'replace';

interface RouterValue extends Route {
  /** Route path without its `?query`, so existing route checks keep working. */
  path: string;
  /** Path plus `?query`, as shown in the address bar. */
  fullPath: string;
  search: URLSearchParams;
  navigate: (path: string) => void;
  /** Rewrites only the query of the current entry (no new history entry). */
  replaceQuery: (params: Record<string, string | null | undefined>) => void;
  /** True when an earlier CRM screen exists in this tab's history. */
  canGoBack: boolean;
  /** Goes back to the previous CRM screen, or to `fallback` on direct entry. */
  goBack: (fallback: string) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function routePathFromLocation(pathname: string, hash: string): string {
  if (pathname === '/oauth/consent') return '/oauth/consent';
  const hashPath = hash.replace(/^#/, '');
  return hashPath || '/';
}

function currentPath(): string {
  return routePathFromLocation(window.location.pathname, window.location.hash);
}

export function splitRoutePath(full: string): { pathname: string; query: string } {
  const index = full.indexOf('?');
  return index < 0
    ? { pathname: full || '/', query: '' }
    : { pathname: full.slice(0, index) || '/', query: full.slice(index + 1) };
}

/** Matches `/enquiries/:id` against `/enquiries/abc` (any `?query` ignored). */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = splitRoutePath(path).pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(':')) {
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return null;
      }
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

// --- Scroll memory ------------------------------------------------------------
// Returning to a long list lands near where the operator left it; opening a
// new screen starts at the top. Positions live for this tab only.

const SCROLL_KEY = 'vishar.crm.scroll.v1';

function readScrollMemory(): Record<string, number> {
  try {
    const raw = window.sessionStorage.getItem(SCROLL_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

export function rememberScroll(fullPath: string, y: number) {
  try {
    const memory = readScrollMemory();
    memory[fullPath] = Math.max(0, Math.round(y));
    const keys = Object.keys(memory);
    // Bounded: keep the 40 most recent entries.
    for (const key of keys.slice(0, Math.max(0, keys.length - 40))) delete memory[key];
    window.sessionStorage.setItem(SCROLL_KEY, JSON.stringify(memory));
  } catch { /* storage unavailable: nothing to restore later */ }
}

export function recalledScroll(fullPath: string): number | null {
  const value = readScrollMemory()[fullPath];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeScrollTo(y: number) {
  try { window.scrollTo({ top: y, left: 0, behavior: 'auto' }); } catch { /* jsdom */ }
}

/**
 * Lists render after their data arrives, so a remembered position may be
 * taller than the page for a moment. Retry briefly until it fits.
 */
function restoreScroll(y: number) {
  const startedAt = Date.now();
  const attempt = () => {
    const room = document.documentElement.scrollHeight - window.innerHeight;
    if (room >= y || Date.now() - startedAt > 2000) {
      safeScrollTo(Math.min(y, Math.max(room, 0)));
      return;
    }
    window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}

// --- History position -----------------------------------------------------------

interface HistoryMark {
  visharIndex: number;
}

function historyIndex(): number | null {
  const state = window.history.state as Partial<HistoryMark> | null;
  return state && typeof state.visharIndex === 'number' ? state.visharIndex : null;
}

function markHistory(index: number) {
  try {
    window.history.replaceState({ ...(window.history.state ?? {}), visharIndex: index }, '');
  } catch { /* history unavailable */ }
}

export function RouterProvider({ children, initialPath }: { children: ReactNode; initialPath?: string }) {
  const [fullPath, setFullPath] = useState(() => initialPath ?? currentPath());
  // In-memory history for tests and embedded renders (initialPath set).
  const [memoryStack, setMemoryStack] = useState<string[]>(() => [initialPath ?? '']);
  const [index, setIndex] = useState(() => {
    if (initialPath) return 0;
    const existing = historyIndex();
    if (existing !== null) return existing;
    markHistory(0);
    return 0;
  });
  const [kind, setKind] = useState<NavigationKind>('initial');
  const indexRef = useRef(index);
  const fullPathRef = useRef(fullPath);
  const pendingPush = useRef(false);
  indexRef.current = index;
  fullPathRef.current = fullPath;

  useEffect(() => {
    if (initialPath) return undefined;
    try { window.history.scrollRestoration = 'manual'; } catch { /* unsupported */ }
    const onHashChange = () => {
      rememberScroll(fullPathRef.current, window.scrollY);
      const existing = historyIndex();
      if (existing !== null && !pendingPush.current) {
        setIndex(existing);
        setKind('pop');
      } else {
        const next = indexRef.current + 1;
        markHistory(next);
        setIndex(next);
        setKind('push');
      }
      pendingPush.current = false;
      setFullPath(currentPath());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [initialPath]);

  useLayoutEffect(() => {
    if (kind === 'push') safeScrollTo(0);
    if (kind === 'pop') {
      const y = recalledScroll(fullPath);
      if (y !== null) restoreScroll(y);
    }
  }, [fullPath, kind]);

  const navigate = useCallback((next: string) => {
    if (next === fullPathRef.current) return;
    if (initialPath) {
      rememberScroll(fullPathRef.current, typeof window !== 'undefined' ? window.scrollY : 0);
      setMemoryStack((stack) => [...stack.slice(0, indexRef.current + 1), next]);
      setIndex((value) => value + 1);
      setKind('push');
      setFullPath(next);
      return;
    }
    pendingPush.current = true;
    window.location.hash = next;
  }, [initialPath]);

  const replaceQuery = useCallback((params: Record<string, string | null | undefined>) => {
    const { pathname, query } = splitRoutePath(fullPathRef.current);
    const search = new URLSearchParams(query);
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === '') search.delete(key);
      else search.set(key, value);
    }
    const text = search.toString();
    const next = text ? `${pathname}?${text}` : pathname;
    if (next === fullPathRef.current) return;
    if (!initialPath) {
      try {
        window.history.replaceState(window.history.state, '', `#${next}`);
      } catch { /* history unavailable */ }
    } else {
      setMemoryStack((stack) => stack.map((entry, position) => (position === indexRef.current ? next : entry)));
    }
    setKind('replace');
    setFullPath(next);
  }, [initialPath]);

  const canGoBack = index > 0;
  const goBack = useCallback((fallback: string) => {
    if (indexRef.current > 0) {
      if (initialPath) {
        rememberScroll(fullPathRef.current, typeof window !== 'undefined' ? window.scrollY : 0);
        const target = memoryStack[indexRef.current - 1] ?? fallback;
        setIndex((value) => value - 1);
        setKind('pop');
        setFullPath(target);
        return;
      }
      window.history.back();
      return;
    }
    navigate(fallback);
  }, [initialPath, memoryStack, navigate]);

  const value = useMemo<RouterValue>(() => {
    const { pathname, query } = splitRoutePath(fullPath);
    return {
      path: pathname,
      fullPath,
      search: new URLSearchParams(query),
      params: {},
      navigate,
      replaceQuery,
      canGoBack,
      goBack,
    };
  }, [fullPath, navigate, replaceQuery, canGoBack, goBack]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter must be used inside a RouterProvider');
  return value;
}

/**
 * A list filter kept in the address (`#/enquiries?status=new`), so it survives
 * opening a record and coming back, a reload, and a shared link.
 */
export function useQueryState(key: string, fallback = ''): [string, (value: string) => void] {
  const { search, replaceQuery } = useRouter();
  const value = search.get(key) ?? fallback;
  const setValue = useCallback((next: string) => {
    replaceQuery({ [key]: next === fallback ? null : next });
  }, [key, fallback, replaceQuery]);
  return [value, setValue];
}

export function Link({
  to,
  children,
  className,
  ariaCurrent,
  style,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  ariaCurrent?: 'page' | undefined;
  style?: CSSProperties;
}) {
  const { navigate } = useRouter();
  return (
    <a
      href={`#${to}`}
      className={className}
      aria-current={ariaCurrent}
      style={style}
      onClick={(event) => {
        // Let the browser handle modified clicks so "open in new tab" works.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}