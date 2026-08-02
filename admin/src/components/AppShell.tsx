// Application chrome: a sticky header and a thumb-reachable bottom tab bar.
//
// Navigation is filtered by role. That is a usability decision, not a security
// one — a hidden tab is not protection, and RequireCapability plus the database
// are what actually refuse access.

import type { ReactNode } from 'react';
import { useLanguage } from '../lib/i18n';
import { Link, useRouter } from '../lib/router';
import { navItemsFor } from '../lib/permissions';
import { useSession } from '../lib/session';
import { LanguageSwitcher } from './LanguageSwitcher';

const NAV_KEYS: Record<string, string> = {
  '/': 'nav.dashboard',
  '/enquiries': 'nav.enquiries',
  '/clients': 'nav.clients',
  '/projects': 'nav.projects',
  '/sessions': 'nav.sessions',
  '/users': 'nav.users',
  '/activity': 'nav.activity',
};

export function AppShell({ children }: { children: ReactNode }) {
  const { profile, signOut } = useSession();
  const { path } = useRouter();
  const { t, label } = useLanguage();
  const items = navItemsFor(profile?.role);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-identity">
          <h1>Vishar CRM</h1>
          <div className="who">
            {profile?.display_name || profile?.email}
            {profile ? ` · ${label('role', profile.role)}` : ''}
          </div>
        </div>
        <div className="topbar-actions">
          <LanguageSwitcher />
          <button type="button" onClick={() => { void signOut(); }}>{t('common.signOut')}</button>
        </div>
      </header>

      <main className="container" id="main">{children}</main>

      <nav className="tabbar" aria-label={t('nav.sections')}>
        {items.map((item) => (
          <Link key={item.path} to={item.path} ariaCurrent={path === item.path ? 'page' : undefined}>
            {t(NAV_KEYS[item.path] ?? item.label)}
          </Link>
        ))}
      </nav>
    </div>
  );
}
