import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterProvider, useRouter } from '../lib/router';

function RouteProbe() {
  const { path } = useRouter();
  return <div data-testid="route-path">{path}</div>;
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('OAuth consent direct routing', () => {
  it('routes the Supabase consent callback path without consuming authorization_id', () => {
    window.history.replaceState({}, '', '/oauth/consent?authorization_id=synthetic-authorization-id');

    render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    );

    expect(screen.getByTestId('route-path')).toHaveTextContent('/oauth/consent');
    expect(new URLSearchParams(window.location.search).get('authorization_id')).toBe('synthetic-authorization-id');
  });

  it('accepts the trailing-slash consent path', () => {
    window.history.replaceState({}, '', '/oauth/consent/?authorization_id=synthetic-authorization-id');

    render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    );

    expect(screen.getByTestId('route-path')).toHaveTextContent('/oauth/consent');
  });

  it('keeps existing hash navigation authoritative', () => {
    window.history.replaceState({}, '', '/oauth/consent?authorization_id=synthetic-authorization-id#/clients');

    render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    );

    expect(screen.getByTestId('route-path')).toHaveTextContent('/clients');
  });

  it('does not expose arbitrary direct paths through the hash router', () => {
    window.history.replaceState({}, '', '/clients');

    render(
      <RouterProvider>
        <RouteProbe />
      </RouterProvider>,
    );

    expect(screen.getByTestId('route-path')).toHaveTextContent('/');
  });
});
