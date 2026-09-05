// Responsive application chrome.
//
// Phone navigation is intentionally capped at five thumb-reachable actions.
// Everything else moves into the overflow sheet instead of extending the tab
// bar horizontally. Wider screens use a persistent sidebar. This is a usability
// decision only: RequireCapability and database policies remain the security
// boundary.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLanguage, type Language } from '../lib/i18n';
import { Link, useRouter } from '../lib/router';
import { navItemsFor, type NavItem } from '../lib/permissions';
import { useSession } from '../lib/session';
import { LanguageSwitcher } from './LanguageSwitcher';
import { useArtistScope } from '../lib/artist-scope';
import { useControlPlaneAccess } from '../lib/control-plane-access';
import { isPathAvailableOnSurface, useSurface } from '../lib/surface';
import { ACCOUNT_PATH } from '../lib/account-api';

// Every navigation destination, so a label can never fall through to its
// English NavItem.label. Communications and Payments had no entry here and
// rendered in English inside the Russian interface, because translate()
// returns the key it was given when the key is not in the dictionary.
const NAV_KEYS: Record<string, string> = {
  '/': 'nav.dashboard',
  '/inbox': 'nav.inbox',
  '/enquiries': 'nav.enquiries',
  '/clients': 'nav.clients',
  '/projects': 'nav.projects',
  '/appointments': 'nav.appointments',
  '/sessions': 'nav.appointments',
  '/availability': 'nav.availability',
  '/statistics': 'nav.statistics',
  '/automations': 'nav.automations',
  '/payments': 'nav.payments',
  '/integrations': 'nav.integrations',
  '/notifications': 'nav.notifications',
  '/workspaces': 'nav.workspaces',
  '/users': 'nav.users',
  '/activity': 'nav.activity',
};

// The four thumb slots go to where a day is actually spent: what needs me, who
// is waiting, when, and who this is. Enquiries and Projects are reached from
// those - an enquiry is an inbound message, and a project is something a client
// wants - so both moved into the overflow sheet rather than holding a slot.
const MOBILE_PRIMARY_PATHS = ['/', '/inbox', '/appointments', '/clients'] as const;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type PageScope = 'artist' | 'shared' | 'global';

/**
 * One grouping, used by the sidebar and the phone's overflow sheet alike.
 *
 * The sheet already grouped its destinations while the sidebar - the roomier
 * surface - was a flat list of thirteen. Both now say the same thing: the work,
 * the money, and the things you set up once.
 */
type NavGroupId = 'work' | 'money' | 'setup';

const NAV_GROUP_ORDER: NavGroupId[] = ['work', 'money', 'setup'];

export function AppShell({ children }: { children: ReactNode }) {
  const { profile, memberships, account, signOut } = useSession();
  const { path } = useRouter();
  const { t, label, language } = useLanguage();
  // The control-plane entry is appended from the server's answer rather than
  // derived from the legacy role, which cannot express workspace authority.
  // Placed before Users so Administration keeps its existing reading order.
  const { canOpenControlPlane } = useControlPlaneAccess();
  // The public CRM never offers the installation's own administration. The
  // database refuses it to a non-owner anyway; this stops the public build
  // showing a door that only the operator environment has.
  const surface = useSurface();
  const roleItems = navItemsFor(profile?.role, memberships)
    .filter((item) => isPathAvailableOnSurface(item.path, surface));
  const items = useMemo<NavItem[]>(() => {
    if (!canOpenControlPlane) return roleItems;
    const workspaces: NavItem = {
      path: '/workspaces',
      label: 'nav.workspaces',
      // Only reached when the server already said yes; the capability is
      // carried so the NavItem shape stays uniform, never to decide access.
      capability: 'viewNotifications',
    };
    const usersAt = roleItems.findIndex((item) => item.path === '/users');
    if (usersAt === -1) return [...roleItems, workspaces];
    return [...roleItems.slice(0, usersAt), workspaces, ...roleItems.slice(usersAt)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canOpenControlPlane, profile?.role, memberships]);
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
  const overflowGroups = groupNavItems(overflowItems);
  const sidebarGroups = groupNavItems(items);
  const overflowIsActive = overflowItems.some((item) => isActivePath(item.path, path));
  const activeItem = items.find((item) => isActivePath(item.path, path));
  const profileName = profile?.display_name || profile?.email || 'CRM';
  // What the person is, not which authorization role carries it. The server
  // works this out from the membership rows authorization itself reads
  // (public.account_overview); if that read failed there is no answer to show
  // and the interface says what it has always said - the global role.
  const roleLabel = account
    ? t(`userRole.${account.user_role}`)
    : profile ? label('role', profile.role) : '';
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
        {/* Grouped exactly as the phone's overflow sheet groups, so the two
            surfaces tell one story. This was a flat list of thirteen. */}
        <nav className="sidebar-nav">
          {sidebarGroups.map((group) => {
            // Named through `aria-label` rather than a heading: the group label
            // is a divider, and adding it to the document outline would put
            // three headings above every page's own.
            return (
              <div
                key={group.id}
                className="sidebar-group"
                role="group"
                aria-label={navGroupLabel(group.id, language)}
              >
                <span className="sidebar-group-heading" aria-hidden="true">
                  {navGroupLabel(group.id, language)}
                </span>
                {group.items.map((item) => (
                  <NavigationLink
                    key={item.path}
                    item={item}
                    path={path}
                    label={item.path === '/automations'
                      ? (language === 'ru' ? 'Автоматические сообщения' : 'Automatic messages')
                      : t(NAV_KEYS[item.path] ?? item.label)}
                  />
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-user">
          <span className="profile-avatar" aria-hidden="true">{initials(profileName)}</span>
          <span className="sidebar-user-copy">
            <strong>{profileName}</strong>
            {roleLabel ? <small>{roleLabel}</small> : null}
          </span>
        </div>
      </aside>

      <div className="app-workspace">
        <header className="topbar">
          <div className="topbar-main">
            <div className="topbar-identity">
              <h1>
                <span className="topbar-brand">Vishar CRM</span>
                <span className="topbar-page-title">
                  {activeItem
                    ? activeItem.path === '/automations'
                      ? (language === 'ru' ? 'Автоматические сообщения' : 'Automatic messages')
                      : t(NAV_KEYS[activeItem.path] ?? activeItem.label)
                    : 'Vishar CRM'}
                </span>
              </h1>
            </div>
            <ProfileMenu
              profileName={profileName}
              roleLabel={roleLabel}
              accountPath={ACCOUNT_PATH}
              accountLabel={t('account.openAccount')}
              menuLabel={t('account.menuLabel')}
              signOutLabel={t('common.signOut')}
              path={path}
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
            label={item.path === '/automations'
              ? (language === 'ru' ? 'Автоматические сообщения' : 'Automatic messages')
              : t(NAV_KEYS[item.path] ?? item.label)}
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
            <nav className="nav-sheet-groups" aria-label={t('nav.sections')}>
              {overflowGroups.map((group) => {
                const headingId = `mobile-more-${group.id}`;
                return (
                  <div
                    key={group.id}
                    className="nav-sheet-group"
                    role="group"
                    aria-labelledby={headingId}
                  >
                    <h3 id={headingId}>{navGroupLabel(group.id, language)}</h3>
                    <div className="nav-sheet-list">
                      {group.items.map((item) => (
                        <NavigationLink
                          key={item.path}
                          item={item}
                          path={path}
                          label={item.path === '/automations'
                            ? (language === 'ru' ? 'Автоматические сообщения' : 'Automatic messages')
                            : t(NAV_KEYS[item.path] ?? item.label)}
                          sheet
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
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

/**
 * The account popover.
 *
 * This was a native `<details>`, which behaves like a menu until you tap
 * somewhere else: `<details>` has no notion of "outside", so the panel stayed
 * open over whatever you tapped next. It is a controlled popover now, dismissed
 * by a pointer outside it, by Escape, and by arriving somewhere new.
 *
 * `pointerdown` rather than `click` is what makes "tapping outside closes it"
 * and "tapping a control inside runs the control" both true: the event starts
 * inside the panel for anything the panel owns, so those never reach the
 * dismiss path, and the control's own click still lands.
 *
 * The person's name is a real Link to their account rather than a decorated
 * span - so it is reachable by keyboard, announced as a link, and openable in a
 * new tab like every other destination in the CRM.
 */
function ProfileMenu({
  profileName,
  roleLabel,
  accountPath,
  accountLabel,
  menuLabel,
  signOutLabel,
  path,
  onSignOut,
}: {
  profileName: string;
  roleLabel: string;
  accountPath: string;
  accountLabel: string;
  menuLabel: string;
  signOutLabel: string;
  path: string;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Somewhere new means the popover has done its job.
  useEffect(() => { setOpen(false); }, [path]);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      const container = containerRef.current;
      const target = event.target;
      if (!container || !(target instanceof Node) || container.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    // Both are removed on every close and on unmount, so nothing outlives the
    // render that added it.
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="profile-menu" ref={containerRef}>
      <button
        type="button"
        className="profile-trigger"
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="profile-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="profile-avatar" aria-hidden="true">{initials(profileName)}</span>
        <span className="profile-trigger-copy">
          <strong>{profileName}</strong>
          {roleLabel ? <small>{roleLabel}</small> : null}
        </span>
        <span className="profile-chevron" aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className="profile-panel" id="profile-panel">
          {/* The name is the control. Its accessible name says where it goes,
              because "Sam" on its own does not. */}
          <Link
            to={accountPath}
            className="profile-panel-account"
            ariaCurrent={path === accountPath ? 'page' : undefined}
          >
            <span className="profile-panel-user">
              <strong>{profileName}</strong>
              {roleLabel ? <small>{roleLabel}</small> : null}
            </span>
            <span className="profile-panel-account-hint">{accountLabel}</span>
          </Link>
          <LanguageSwitcher />
          <button type="button" className="profile-signout" onClick={onSignOut}>{signOutLabel}</button>
        </div>
      ) : null}
    </div>
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

export function groupNavItems(items: NavItem[]): { id: NavGroupId; items: NavItem[] }[] {
  const grouped = new Map<NavGroupId, NavItem[]>();
  for (const item of items) {
    const id = navGroupFor(item.path);
    const group = grouped.get(id) ?? [];
    group.push(item);
    grouped.set(id, group);
  }
  return NAV_GROUP_ORDER
    .map((id) => ({ id, items: grouped.get(id) ?? [] }))
    .filter((group) => group.items.length > 0);
}

/**
 * Frequency, not entity. A destination belongs to `setup` when it is configured
 * and then left alone - which is what "Time off", "Automations" and the whole
 * administration group have in common, whatever table they read.
 */
export function navGroupFor(path: string): NavGroupId {
  if (path === '/finance' || path === '/payments') return 'money';
  // Statistics reads the work rather than the money: its finance block is one
  // section of it and appears only where the database returns finance rows.
  if (path === '/statistics') return 'work';
  if (
    path === '/availability'
    || path === '/automations'
    || path === '/notifications'
    || path === '/activity'
    || path === '/users'
    || path === '/workspaces'
    || path.startsWith('/workspaces/')
    || path.startsWith('/artists/')
    || path.startsWith('/integrations')
    || path === '/settings'
  ) return 'setup';
  return 'work';
}

function navGroupLabel(group: NavGroupId, language: Language): string {
  const labels: Record<Language, Record<NavGroupId, string>> = {
    en: {
      work: 'Work',
      money: 'Money',
      setup: 'Setup',
    },
    ru: {
      work: 'Работа',
      money: 'Деньги',
      setup: 'Настройки',
    },
  };
  return labels[language][group];
}

function pageScopeFor(path: string): PageScope {
  if (path === '/clients' || path.startsWith('/clients/')) return 'shared';
  if (
    path === '/'
    || path === '/enquiries'
    || path.startsWith('/enquiries/')
    || path === '/projects'
    || path.startsWith('/projects/')
    || path === '/appointments'
    || path === '/sessions'
    || path === '/availability'
    || path === '/automations'
    || path.startsWith('/automations/')
    || path === '/activity'
    // The Inbox reads artist-owned rows - communication_conversations and
    // email_messages are both scoped by artist_id - and InboxPage has always
    // filtered by the selected artist. Classifying it as global put a "not
    // filtered by artist" notice above a list that was being filtered by
    // artist, and hid the control that decides it.
    || path === '/inbox'
    // Payments is artist-owned: deposit settings, the destination catalogue,
    // the deposit policy and every reconciliation candidate belong to exactly
    // one artist, and PaymentsPage cannot render without one. Classifying it
    // as global hid the selector on the one screen that requires a selection.
    || path === '/payments'
    // Every figure on Statistics is an artist-owned record, and the screen
    // passes the selected artist into each read.
    || path === '/statistics'
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
  if (itemPath === '/appointments' && currentPath === '/sessions') return true;
  if (itemPath === '/integrations') return currentPath === '/integrations' || currentPath === '/integrations/calendar';
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
    // The Inbox holds a thumb slot, so it cannot fall through to the default
    // glyph: that is the same three dots the More trigger uses.
    case '/inbox':
      return <svg {...common}><path d="M4 5h16v11H9l-4 3.5V16H4z" /></svg>;
    case '/enquiries':
      return <svg {...common}><path d="M4 5h16v14H4z" /><path d="M4 13h4l2 3h4l2-3h4" /></svg>;
    case '/clients':
      return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><circle cx="17" cy="9" r="2.5" /><path d="M15.5 14.5A5 5 0 0 1 21 19" /></svg>;
    case '/projects':
      return <svg {...common}><path d="M3 6.5h7l2 2h9v10.5H3z" /><path d="M3 6.5V5h7l2 2" /></svg>;
    case '/appointments':
    case '/sessions':
      return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /><path d="M8 14h3M8 17h6" /></svg>;
    case '/availability':
      return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /><path d="M8 15h8" /></svg>;
    case '/automations':
      return <svg {...common}><path d="M5 7h14M5 12h14M5 17h14" /><circle cx="9" cy="7" r="2" fill="var(--surface)" /><circle cx="15" cy="12" r="2" fill="var(--surface)" /><circle cx="11" cy="17" r="2" fill="var(--surface)" /></svg>;
    case '/users':
      return <svg {...common}><circle cx="12" cy="8" r="3" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /><path d="M19 5v4M17 7h4" /></svg>;
    case '/activity':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case '/statistics':
      return <svg {...common}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
    default:
      return <svg {...common}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>;
  }
}