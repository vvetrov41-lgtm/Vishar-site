// A minimal hash router.
//
// Nine routes do not justify a routing dependency, and a hash router works on
// any static host without server rewrite rules — which matters because the CRM
// is hosted separately from the public site and the hosting choice is still an
// owner decision.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

export interface Route {
  path: string;
  params: Record<string, string>;
}

interface RouterValue extends Route {
  navigate: (path: string) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

const DIRECT_ENTRY_PATHS: Readonly<Record<string, string>> = Object.freeze({
  '/oauth/consent': '/oauth/consent',
  '/oauth/consent/': '/oauth/consent',
});

function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) return hash;

  // Supabase OAuth Server redirects the browser to the configured authorization
  // path as a normal pathname, not a hash route. Preserve exactly that one
  // external entry point so the pending authorization_id reaches the consent
  // screen. All ordinary CRM navigation remains hash-based.
  return DIRECT_ENTRY_PATHS[window.location.pathname] ?? '/';
}

/** Matches `/enquiries/:id` against `/enquiries/abc`. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
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

export function RouterProvider({ children, initialPath }: { children: ReactNode; initialPath?: string }) {
  const [path, setPath] = useState(() => initialPath ?? currentPath());

  useEffect(() => {
    if (initialPath) return undefined;
    const onHashChange = () => setPath(currentPath());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [initialPath]);

  const navigate = useCallback((next: string) => {
    setPath(next);
    if (!initialPath) window.location.hash = next;
  }, [initialPath]);

  const value = useMemo<RouterValue>(() => ({ path, params: {}, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter must be used inside a RouterProvider');
  return value;
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

export const __testing = Object.freeze({ currentPath });
