// Public artist signup, from the browser's side of the boundary.
//
// Everything that actually decides anything here is the database - the tests
// that prove isolation and privilege live in supabase/tests/267. What this
// file is responsible for is that the interface asks the right question at the
// right moment, and that it fails closed when the server says no.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import type { CrmClient } from '../lib/api';
import { RouterProvider } from '../lib/router';
import { SessionProvider } from '../lib/session';
import {
  authCallbackKind,
  isSignupConfirmationUrl,
  isStaffInviteUrl,
  signupRedirectUrl,
} from '../lib/supabase';
import { passwordProblem } from '../lib/password';

const PASSWORD = 'Synthetic-Strong-Password-42!';
const ARTIST_ID = 'aa111111-1111-4111-8111-111111111111';

interface Call {
  name: string;
  args?: Record<string, unknown>;
}

interface HarnessOptions {
  signedIn?: boolean;
  emailConfirmed?: boolean;
  signupOpen?: boolean;
  signUpError?: boolean;
  resendError?: boolean;
  /** An RPC the database refuses, with its SQLSTATE. */
  failBootstrap?: { code: string; message: string };
}

function createClient(options: HarnessOptions) {
  const calls: Call[] = [];
  const auth: Record<string, unknown> = {};
  let signedIn = options.signedIn ?? false;
  let confirmed = options.emailConfirmed ?? false;

  const client = {
    // Enough of PostgREST for the access gate: `profiles` is read with
    // `.maybeSingle()` and returns nothing, and `artist_memberships` with two
    // `.eq()` filters and returns nothing. Both are the honest answer for an
    // account that has no CRM identity yet.
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          eq: async () => ({ data: [], error: null }),
        }),
      }),
    }),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
    rpc: async (name: string, args?: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'self_service_signup_policy') {
        return { data: { is_open: options.signupOpen === true }, error: null };
      }
      if (name === 'bootstrap_artist_account') {
        if (options.failBootstrap) return { data: null, error: options.failBootstrap };
        return {
          data: {
            profile_id: '99999999-9999-4999-8999-999999999999',
            workspace_id: 'ww111111-1111-4111-8111-111111111111',
            artist_id: ARTIST_ID,
            created: true,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    auth: Object.assign(auth, {
      getSession: async () => ({
        data: {
          session: signedIn
            ? {
              user: {
                id: '99999999-9999-4999-8999-999999999999',
                email: 'new.artist@example.test',
                email_confirmed_at: confirmed ? '2026-01-01T00:00:00.000Z' : null,
              },
            }
            : null,
        },
        error: null,
      }),
      signInWithPassword: async () => ({ data: {}, error: null }),
      signOut: async () => { signedIn = false; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signUp: async (credentials: { email: string; password: string; options?: { emailRedirectTo?: string } }) => {
        calls.push({
          name: 'auth.signUp',
          args: {
            email: credentials.email,
            passwordLength: credentials.password.length,
            emailRedirectTo: credentials.options?.emailRedirectTo,
          },
        });
        if (options.signUpError) {
          return { data: { session: null, user: null }, error: { message: 'User already registered' } };
        }
        // The production shape: no session until the address is confirmed.
        return { data: { session: null, user: {} }, error: null };
      },
      resend: async (payload: { type: string; email: string; options?: { emailRedirectTo?: string } }) => {
        calls.push({
          name: 'auth.resend',
          args: {
            type: payload.type,
            email: payload.email,
            emailRedirectTo: payload.options?.emailRedirectTo,
          },
        });
        if (options.resendError) return { data: {}, error: { message: 'rate limited' } };
        return { data: {}, error: null };
      },
    }),
  } as unknown as CrmClient;

  return {
    client,
    calls,
    confirmEmail() { confirmed = true; },
  };
}

// Deliberately not `initialPath`: a pinned router never writes the hash, and
// where this flow sends somebody afterwards is part of what is being tested.
function renderApp(options: HarnessOptions, path = '/') {
  window.history.replaceState({}, '', path === '/' ? '/' : `/#${path}`);
  const harness = createClient(options);
  render(
    <SessionProvider client={harness.client}>
      <RouterProvider>
        <App />
      </RouterProvider>
    </SessionProvider>
  );
  return harness;
}

beforeEach(() => {
  window.localStorage.setItem('vishar-crm-language', 'en');
  window.history.replaceState({}, '', '/');
});

describe('the Auth callback markers', () => {
  it('accepts exactly the two markers the CRM owns, and nothing wider', () => {
    expect(authCallbackKind('https://crm.vishartattoo.com/?staff_invite=1')).toBe('staff_invite');
    expect(authCallbackKind('https://crm.vishartattoo.com/?signup=1')).toBe('signup');
    expect(isSignupConfirmationUrl('https://crm.vishartattoo.com/?signup=1')).toBe(true);
    expect(isStaffInviteUrl('https://crm.vishartattoo.com/?signup=1')).toBe(false);

    // A widened URL turns URL session detection off rather than on.
    for (const url of [
      'https://crm.vishartattoo.com/?signup=1&next=/users',
      'https://crm.vishartattoo.com/?signup=2',
      'https://crm.vishartattoo.com/setup?signup=1',
      'https://crm.vishartattoo.com/',
    ]) {
      expect(authCallbackKind(url)).toBeNull();
    }
  });

  it('builds a confirmation redirect its own matcher accepts', () => {
    const url = signupRedirectUrl('https://crm.vishartattoo.com');
    expect(url).toBe('https://crm.vishartattoo.com/?signup=1');
    expect(authCallbackKind(url)).toBe('signup');
    expect(authCallbackKind(signupRedirectUrl('https://crm.vishartattoo.com/'))).toBe('signup');
  });
});

describe('the password rule', () => {
  it('is one rule, and both screens read it', () => {
    expect(passwordProblem('short')).toBe('length');
    expect(passwordProblem('a'.repeat(129))).toBe('length');
    expect(passwordProblem(PASSWORD)).toBeNull();
    expect(passwordProblem(PASSWORD, 'something else')).toBe('mismatch');
    expect(passwordProblem(PASSWORD, PASSWORD)).toBeNull();
  });
});

describe('the sign-in screen', () => {
  it('offers signup only when the server says the door is open', async () => {
    renderApp({ signupOpen: true });
    expect(await screen.findByRole('link', { name: /create an account/i })).toBeInTheDocument();
  });

  it('hides signup when the server says it is closed', async () => {
    renderApp({ signupOpen: false });
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /create an account/i })).not.toBeInTheDocument();
  });
});

describe('creating an account', () => {
  it('creates an Auth identity, nothing in the CRM, and says to go and read the email', async () => {
    const { calls } = renderApp({ signupOpen: true }, '/signup');

    fireEvent.change(await screen.findByLabelText(/^email$/i), {
      target: { value: 'new.artist@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText(/repeat password/i), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
    expect(screen.getByText(/new\.artist@example\.test/)).toBeInTheDocument();

    const signUp = calls.find((call) => call.name === 'auth.signUp');
    expect(signUp?.args?.emailRedirectTo).toMatch(/\?signup=1$/);
    // Nothing was created in the CRM by signing up.
    expect(calls.some((call) => call.name === 'bootstrap_artist_account')).toBe(false);
  });

  it('resends confirmation when Auth already has a pending signup for the address', async () => {
    const { calls } = renderApp({ signupOpen: true, signUpError: true }, '/signup');

    fireEvent.change(await screen.findByLabelText(/^email$/i), {
      target: { value: 'new.artist@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText(/repeat password/i), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const resend = calls.find((call) => call.name === 'auth.resend');
    expect(resend?.args?.type).toBe('signup');
    expect(resend?.args?.email).toBe('new.artist@example.test');
    expect(resend?.args?.emailRedirectTo).toMatch(/\?signup=1$/);
    expect(calls.some((call) => call.name === 'bootstrap_artist_account')).toBe(false);
  });

  it('keeps the generic failure when both signup and resend fail', async () => {
    const { calls } = renderApp({ signupOpen: true, signUpError: true, resendError: true }, '/signup');

    fireEvent.change(await screen.findByLabelText(/^email$/i), {
      target: { value: 'new.artist@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText(/repeat password/i), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/that did not work/i);
    expect(calls.filter((call) => call.name === 'auth.resend')).toHaveLength(1);
  });

  it('refuses a mismatched confirmation before contacting the server', async () => {
    const { calls } = renderApp({ signupOpen: true }, '/signup');

    fireEvent.change(await screen.findByLabelText(/^email$/i), {
      target: { value: 'new.artist@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText(/repeat password/i), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not the same/i);
    expect(calls.some((call) => call.name === 'auth.signUp')).toBe(false);
  });

  it('refuses a short password before contacting the server', async () => {
    const { calls } = renderApp({ signupOpen: true }, '/signup');

    fireEvent.change(await screen.findByLabelText(/^email$/i), {
      target: { value: 'new.artist@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText(/repeat password/i), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/between 12 and 128/i);
    expect(calls.some((call) => call.name === 'auth.signUp')).toBe(false);
  });
});

describe('an account that has not confirmed its address', () => {
  it('is held on the confirmation screen and never offered setup', async () => {
    const { calls } = renderApp({ signedIn: true, emailConfirmed: false, signupOpen: true });

    expect(await screen.findByText(/confirm your email/i)).toBeInTheDocument();
    expect(screen.getByText(/new\.artist@example\.test/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument();

    // The signup switch is not even consulted: an unconfirmed address is
    // refused server-side whatever the switch says.
    expect(calls.some((call) => call.name === 'self_service_signup_policy')).toBe(false);
    expect(calls.some((call) => call.name === 'bootstrap_artist_account')).toBe(false);
  });

  it('can ask for another link', async () => {
    const { calls } = renderApp({ signedIn: true, emailConfirmed: false, signupOpen: true });

    fireEvent.click(await screen.findByRole('button', { name: /send another link/i }));
    await waitFor(() => {
      expect(calls.some((call) => call.name === 'auth.resend')).toBe(true);
    });
    expect(await screen.findByRole('status')).toHaveTextContent(/check your inbox/i);
  });
});

describe('a confirmed account with no CRM identity', () => {
  it('is offered setup when signup is open', async () => {
    renderApp({ signedIn: true, emailConfirmed: true, signupOpen: true });
    expect(await screen.findByText(/set up your crm/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
  });

  it('is refused, exactly as before, when signup is closed', async () => {
    renderApp({ signedIn: true, emailConfirmed: true, signupOpen: false });
    expect(await screen.findByText(/no CRM access/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument();
  });

  it('creates the whole tenant from one call and opens its checklist', async () => {
    const { calls } = renderApp({ signedIn: true, emailConfirmed: true, signupOpen: true });

    fireEvent.change(await screen.findByLabelText(/your name/i), {
      target: { value: 'Nina Newcomer' },
    });
    fireEvent.change(screen.getByLabelText(/business or studio name/i), {
      target: { value: 'Nina Ink' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.name === 'bootstrap_artist_account')).toBe(true);
    });

    const bootstrap = calls.find((call) => call.name === 'bootstrap_artist_account');
    expect(bootstrap?.args?.p_display_name).toBe('Nina Newcomer');
    expect(bootstrap?.args?.p_business_name).toBe('Nina Ink');
    expect(typeof bootstrap?.args?.p_timezone).toBe('string');

    // No identifier of any kind is sent. The server acts for auth.uid() alone,
    // so there is nothing here a caller could substitute.
    for (const key of Object.keys(bootstrap?.args ?? {})) {
      expect(key).not.toMatch(/_(artist|workspace|profile)_id$/);
    }

    // The setup call is the only write. Nothing creates a workspace, an artist
    // or a membership from the browser.
    for (const forbidden of ['create_workspace', 'create_artist', 'seat_artist_owner',
      'grant_workspace_artist_membership', 'upsert_workspace_membership']) {
      expect(calls.some((call) => call.name === forbidden)).toBe(false);
    }

    expect(window.location.hash).toBe(`#/artists/${ARTIST_ID}`);
  });

  it('refuses to name a workspace, an artist or a role from the form', async () => {
    renderApp({ signedIn: true, emailConfirmed: true, signupOpen: true });
    await screen.findByLabelText(/your name/i);
    expect(screen.queryByLabelText(/organi[sz]ation/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/workspace/i)).not.toBeInTheDocument();
  });

  it('reports a server refusal and creates nothing', async () => {
    const { calls } = renderApp({
      signedIn: true,
      emailConfirmed: true,
      signupOpen: true,
      failBootstrap: { code: '53400', message: 'too many accounts have been created recently' },
    });

    fireEvent.change(await screen.findByLabelText(/your name/i), {
      target: { value: 'Nina Newcomer' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(calls.filter((call) => call.name === 'bootstrap_artist_account')).toHaveLength(1);
    expect(window.location.hash).not.toContain('/artists/');
  });

  it('will not submit an empty name', async () => {
    const { calls } = renderApp({ signedIn: true, emailConfirmed: true, signupOpen: true });
    await screen.findByLabelText(/your name/i);
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter the name/i);
    expect(calls.some((call) => call.name === 'bootstrap_artist_account')).toBe(false);
  });
});
