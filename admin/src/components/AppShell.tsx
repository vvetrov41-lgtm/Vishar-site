// Application chrome: a sticky header and a thumb-reachable bottom tab bar.
//
// Navigation is filtered by role. That is a usability decision, not a security
// one — a hidden tab is not protection, and RequireCapability plus the database
// are what actually refuse access.

import type { ReactNode } from 'react';
import { Link, useRouter } from '../lib/router';
import { navItemsFor, ROLE_LABELS } from '../lib/permissions';
import { useSession } from '../lib/session';

export function AppShell({ children }: { children: ReactNode }) {
  const { profile, signOut } = useSession();
  const { path } = useRouter();
  const items = navItemsFor(profile?.role);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Vishar CRM</h1>
          <div className="who">
            {profile?.display_name || profile?.email}
            {profile ? ` · ${ROLE_LABELS[profile.role]}` : ''}
          </div>
        </div>
        <button type="button" onClick={() => { void signOut(); }}>Sign out</button>
      </header>

      <main className="container" id="main">{children}</main>

      <nav className="tabbar" aria-label="Sections">
        {items.map((item) => (
          <Link key={item.path} to={item.path} ariaCurrent={path === item.path ? 'page' : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
