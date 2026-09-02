// One codebase, two hosts.
//
// The public CRM must not offer the installation's own administration, and the
// operator environment must keep it. Neither of those is the security
// boundary - the database refuses installation-level operations to a
// non-owner on either host, which is what pgTAP 267 pins - so what is tested
// here is the product boundary and the fail-closed default that decides it.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../App';
import { LanguageProvider } from '../lib/i18n';
import { RouterProvider } from '../lib/router';
import { SessionProvider } from '../lib/session';
import {
  INTERNAL_ONLY_PATHS,
  isPathAvailableOnSurface,
  readSurface,
} from '../lib/surface';
import { createFakeClient, renderWithSession } from './fixtures';

describe('reading the surface from the build', () => {
  it('answers internal only when the build says so exactly', () => {
    expect(readSurface({ VITE_CRM_SURFACE: 'internal' })).toBe('internal');
    expect(readSurface({ VITE_CRM_SURFACE: '  internal  ' })).toBe('internal');
  });

  it('fails closed for anything else, including an unset variable', () => {
    for (const value of [undefined, '', 'public', 'Internal', 'INTERNAL', 'operator', 'true']) {
      expect(readSurface({ VITE_CRM_SURFACE: value })).toBe('public');
    }
    expect(readSurface({})).toBe('public');
  });

  it('keeps the operator-only list to the installation, not the tenant', () => {
    expect(INTERNAL_ONLY_PATHS).toContain('/users');
    // A self-service artist owns their own solo organization and has to be
    // able to open it. It is scoped by workspace_access, not installation-wide.
    expect(INTERNAL_ONLY_PATHS).not.toContain('/workspaces');
    expect(INTERNAL_ONLY_PATHS).not.toContain('/integrations');
    expect(INTERNAL_ONLY_PATHS).not.toContain('/payments');
  });

  it('routes every ordinary destination on both surfaces', () => {
    for (const path of ['/', '/inbox', '/clients', '/projects', '/appointments',
      '/payments', '/integrations', '/workspaces', '/activity', '/notifications']) {
      expect(isPathAvailableOnSurface(path, 'public')).toBe(true);
      expect(isPathAvailableOnSurface(path, 'internal')).toBe(true);
    }
    expect(isPathAvailableOnSurface('/users', 'internal')).toBe(true);
    expect(isPathAvailableOnSurface('/users', 'public')).toBe(false);
  });
});

describe('the operator environment', () => {
  it('offers the installation administration to its owner', async () => {
    renderWithSession(<App />, { role: 'owner', surface: 'internal' });
    expect(await screen.findByRole('link', { name: 'Users' })).toBeInTheDocument();
  });

  it('still opens the Users screen there', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/users', surface: 'internal' });
    expect(await screen.findByRole('heading', { name: /invite a team member/i }))
      .toBeInTheDocument();
  });
});

describe('the public CRM', () => {
  it('does not offer the installation administration, even to the owner', async () => {
    renderWithSession(<App />, { role: 'owner', surface: 'public' });
    // The nav rendered, so this is an absence rather than an empty page.
    // Ordinary destinations appear twice - the sidebar and the phone tab bar -
    // which is why these are the plural queries and Users is the singular one.
    expect((await screen.findAllByRole('link', { name: 'Clients' })).length)
      .toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('refuses the operator-only route and says where it lives', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/users', surface: 'public' });
    expect(await screen.findByText(/not part of this CRM/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /invite/i })).not.toBeInTheDocument();
  });

  it('keeps everything an artist actually works in', async () => {
    renderWithSession(<App />, { role: 'owner', surface: 'public' });
    for (const name of ['Today', 'Inbox', 'Clients', 'Projects', 'Calendar']) {
      expect((await screen.findAllByRole('link', { name })).length).toBeGreaterThan(0);
    }
  });
});

describe('a build rendered with no surface at all', () => {
  it('gets the restricted one rather than the permissive one', async () => {
    const client = createFakeClient({ role: 'owner' });
    render(
      <LanguageProvider>
        <SessionProvider client={client}>
          <RouterProvider initialPath="/users">
            <App />
          </RouterProvider>
        </SessionProvider>
      </LanguageProvider>
    );
    expect(await screen.findByText(/not part of this CRM/i)).toBeInTheDocument();
  });
});
