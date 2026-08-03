// Responsive application chrome.
//
// Phone navigation is intentionally capped at five thumb-reachable actions.
// Everything else moves into the overflow sheet instead of extending the tab
// bar horizontally. Wider screens use a persistent sidebar. This is a usability
// decision only: RequireCapability and database policies remain the security
// boundary.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLanguage, type Language } from '../lib/i18n';
import { Link, useRouter } from '../lib/router';
import { navItemsFor, type NavItem } from '../lib/permissions';
import { useSession } from '../lib/session';
import { LanguageSwitcher } from './LanguageSwitcher';
import { useArtistScope } from '../lib/artist-scope';

const NAV_KEYS: Record<string, string> = {
  '/': 'nav.dashboard',
  '/enquiries': 'nav.enquiries',
  '/clients': 'nav.clients',
  '/projects': 'nav.projects',
  '/sessions': 'nav.sessions',
  '/users': 'nav.users',
  '/activity': 'nav.activity',
};

// Order is deliberate. Filtering the general navigation list through a Set
// preserved membership but inherited the desktop ordering, which put Clients
// before Sessions. Keep the phone task order explicit as the CRM expands.
const MOBILE_PRIMARY_PATHS = ['/', '/enquiries', '/sessions', '/clients'] as const;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type PageScope = 'artist' | 'shared' | 'global';

export function AppShell({ children }: { children: ReactNode }) {
  const { profile, signOut } = useSession();
  const { path } = useRouter();
  const { t, label, language } = useLanguage();
  const items = navItemsFor(profile?.role);
  const {
    artists,
    selectedArtistId,
    loading: artistScopeLoading,
    error: artistScopeError,
    setSelectedArtistId,
  } = useArtistScope();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreSheetRef = useRef<HTMLElement | null>(null);
  const currentPathRef = useRef(path);
  currentPathRef.current = path;

  const primaryItems = MOBILE_PRIMARY_PATHS
    .map((primaryPath) => items.find((item) => item.path === primaryPath))
    .filter((item): item is NavItem => Boolean(item));
  const primaryPaths = new Set(primaryItems.map((item) => item.path));
  const overflowItems = items.filter((item) => !primaryPaths.has(item.path));
  const overflowIsActive = overflowItems.some((item) => isActivePath(item.path, path));
  const activeItem = items.find((item) => isActivePath(item.path, path));
  const profileName = profile?.display_name || profile?.email || 'CRM';
  const moreLabel = language === 'ru' ? 'Ещё' : 'More';
  const pageScope = pageScopeFor(path);

  useEffect(() => {
    setMoreOpen(false);
  }, [path]);

  useEffect(() => {
    if (!moreOpen) return undefined;

    const openedPath = path;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      const sheet = moreSheetRef.current;
      const firstFocusable = sheet ? focusableElements(sheet)[0] : null;
      (firstFocusable ?? sheet)?.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      const sheet = moreSheetRef.current;
      if (!sheet) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        setMoreOpen(false);
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = focusableElements(sheet);
      if (focusable.length === 0) {
        event.preventDefault();
        sheet.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !sheet.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !sheet.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Route navigation should move attention into the destination rather than
      // pull it back to a control that is no longer relevant. Explicit dismiss
      // actions restore the trigger because the route has not changed.
      if (currentPathRef.current === openedPath) moreTriggerRef.current?.focus();
    };
  }, [moreOpen]);

  return (
    <div className="app">
      <aside className="sidebar" aria-label={t('nav.sections')}>
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark" aria-hidden="true">V</span>
          <span>
            <strong>Vishar</strong>
            <small>CRM</small>
          </span>
        </div>
        <nav className="sidebar-nav">
          {items.map((item) => (
            <NavigationLink key={item.path} item={item} path={path} label={t(NAV_KEYS[item.path] ?? item.label)} />
          ))}
        </nav>
        <div className="sidebar-user">
          <span className="profile-avatar" aria-hidden="true">{initials(profileName)}</span>
          <span className="sidebar-user-copy">
            <strong>{profileName}</strong>
            {profile ? <small>{label('role', profile.role)}</small> : null}
          </span>
        </div>
      </aside>

      <div className="app-workspace">
        <header className="topbar">
          <div className="topbar-main">
            <div className="topbar-identity">
              <h1>
                <span className="topbar-brand">Vishar CRM</span>
                <span className="topbar-page-title">{activeItem ? t(NAV_KEYS[activeItem.path] ?? activeItem.label) : 'Vishar CRM'}</span>
              </h1>
            </div>
            <ProfileMenu
              profileName={profileName}
              roleLabel={profile ? label('role', profile.role) : ''}
              signOutLabel={t('common.signOut')}
              onSignOut={() => { void signOut(); }}
            />
          </div>

          <ArtistScopeControl
            scope={pageScope}
            language={language}
            artists={artists}
            selectedArtistId={selectedArtistId}
            loading={artistScopeLoading}
            error={artistScopeError}
            label={t('artistScope.label')}
            allAssignedLabel={t('artistScope.allAssigned')}
            onChange={setSelectedArtistId}
          />
        </header>

        <main className="container" id="main">{children}</main>
      </div>

      <nav className="tabbar" aria-label={t('nav.sections')}>
        {primaryItems.map((item) => (
          <NavigationLink
            key={item.path}
            item={item}
            path={path}
            label={t(NAV_KEYS[item.path] ?? item.label)}
            mobile
          />
        ))}
        {overflowItems.length > 0 ? (
          <button
            ref={moreTriggerRef}
            type="button"
            className="tabbar-item"
            aria-expanded={moreOpen}
            aria-controls="mobile-more-navigation"
            aria-current={overflowIsActive ? 'page' : undefined}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <NavIcon path="more" />
            <span>{moreLabel}</span>
          </button>
        ) : null}
      </nav>

      {moreOpen && overflowItems.length > 0 ? (
        <>
          <button
            type="button"
            className="nav-sheet-backdrop"
            aria-label={language === 'ru' ? 'Закрыть меню' : 'Close menu'}
            onClick={() => setMoreOpen(false)}
          />
          <section
            ref={moreSheetRef}
            id="mobile-more-navigation"
            className="nav-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t('nav.sections')}
            tabIndex={-1}
          >
            <div className="nav-sheet-handle" aria-hidden="true" />
            <h2>{t('nav.sections')}</h2>
            <nav className="nav-sheet-list">
              {overflowItems.map((item) => (
                <NavigationLink
                  key={item.path}
                  item={item}
                  path={path}
                  label={t(NAV_KEYS[item.path] ?? item.label)}
                  sheet
                />
              ))}
            </nav>
          </section>
        </>
      ) : null}
    </div>
  );
}

function ArtistScopeControl({
  scope,
  language,
  artists,
  selectedArtistId,
  loading,
  error,
  label,
  allAssignedLabel,
  onChange,
}: {
  scope: PageScope;
  language: Language;
  artists: { id: string; display_name: string }[];
  selectedArtistId: string | null;
  loading: boolean;
  error: boolean;
  label: string;
  allAssignedLabel: string;
  onChange: (artistId: string | null) => void;
}) {
  if (scope !== 'artist') {
    const copy = scopeContextCopy(scope, language);
    return (
      <div className="artist-scope-control">
        <div className="notice" role="status">
          <strong style={{ display: 'block', color: 'var(--text)' }}>{copy.title}</strong>
          <span>{copy.hint}</span>
        </div>
      </div>
    );
  }

  if (error) {
    const copy = artistScopeErrorCopy(language);
    return (
      <div className="artist-scope-control">
        <div className="notice warn" role="alert">
          <strong style={{ display: 'block' }}>{copy.title}</strong>
          <span>{copy.hint}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="artist-scope-control">
      <label htmlFor="artist-scope">{label}</label>
      <select
        id="artist-scope"
        aria-label={label}
        value={selectedArtistId ?? ''}
        disabled={loading}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{allAssignedLabel}</option>
        {artists.map((artist) => (
          <option key={artist.id} value={artist.id}>{artist.display_name}</option>
        ))}
      </select>
    </div>
  );
}

function ProfileMenu({
  profileName,
  roleLabel,
  signOutLabel,
  onSignOut,
}: {
  profileName: string;
  roleLabel: string;
  signOutLabel: string;
  onSignOut: () => void;
}) {
  return (
    <details className="profile-menu">
      <summary className="profile-trigger" aria-label={profileName}>
        <span className="profile-avatar" aria-hidden="true">{initials(profileName)}</span>
        <span className="profile-trigger-copy">
          <strong>{profileName}</strong>
          {roleLabel ? <small>{roleLabel}</small> : null}
        </span>
        <span className="profile-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="profile-panel">
        <div className="profile-panel-user">
          <strong>{profileName}</strong>
          {roleLabel ? <small>{roleLabel}</small> : null}
        </div>
        <LanguageSwitcher />
        <button type="button" className="profile-signout" onClick={onSignOut}>{signOutLabel}</button>
      </div>
    </details>
  );
}

function NavigationLink({
  item,
  path,
  label,
  mobile = false,
  sheet = false,
}: {
  item: NavItem;
  path: string;
  label: string;
  mobile?: boolean;
  sheet?: boolean;
}) {
  const active = isActivePath(item.path, path);
  const className = sheet ? 'nav-sheet-link' : mobile ? 'tabbar-item' : 'sidebar-link';
  return (
    <Link to={item.path} className={className} ariaCurrent={active ? 'page' : undefined}>
      <NavIcon path={item.path} />
      <span>{label}</span>
    </Link>
  );
}

function pageScopeFor(path: string): PageScope {
  if (path === '/clients' || path.startsWith('/clients/')) return 'shared';
  if (
    path === '/'
    || path === '/enquiries'
    || path.startsWith('/enquiries/')
    || path === '/projects'
    || path.startsWith('/projects/')
    || path === '/sessions'
    || path === '/activity'
  ) return 'artist';
  return 'global';
}

function scopeContextCopy(scope: Exclude<PageScope, 'artist'>, language: Language) {
  if (scope === 'shared') {
    return language === 'ru'
      ? { title: 'Общие записи', hint: 'Клиенты не фильтруются по выбранному мастеру.' }
      : { title: 'Shared records', hint: 'Clients are not filtered by the selected artist.' };
  }
  return language === 'ru'
    ? { title: 'Общий раздел', hint: 'Этот раздел не фильтруется по мастеру.' }
    : { title: 'Global section', hint: 'This section is not filtered by artist.' };
}

function artistScopeErrorCopy(language: Language) {
  return language === 'ru'
    ? {
        title: 'Не удалось загрузить список мастеров',
        hint: 'Обновите страницу. Доступ к данным по-прежнему контролируется базой данных.',
      }
    : {
        title: 'Artist list unavailable',
        hint: 'Reload the page. Database access controls remain authoritative.',
      };
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function isActivePath(itemPath: string, currentPath: string): boolean {
  if (itemPath === '/') return currentPath === '/';
  return currentPath === itemPath || currentPath.startsWith(`${itemPath}/`);
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'V';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function NavIcon({ path }: { path: string }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (path) {
    case '/':
      return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>;
    case '/enquiries':
      return <svg {...common}><path d="M4 5h16v14H4z" /><path d="M4 13h4l2 3h4l2-3h4" /></svg>;
    case '/clients':
      return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><circle cx="17" cy="9" r="2.5" /><path d="M15.5 14.5A5 5 0 0 1 21 19" /></svg>;
    case '/projects':
      return <svg {...common}><path d="M3 6.5h7l2 2h9v10.5H3z" /><path d="M3 6.5V5h7l2 2" /></svg>;
    case '/sessions':
      return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /><path d="M8 14h3M8 17h6" /></svg>;
    case '/users':
      return <svg {...common}><circle cx="12" cy="8" r="3" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /><path d="M19 5v4M17 7h4" /></svg>;
    case '/activity':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    default:
      return <svg {...common}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>;
  }
}
