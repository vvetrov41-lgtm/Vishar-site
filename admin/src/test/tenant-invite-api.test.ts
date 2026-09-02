import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../lib/api';

/**
 * The tenant-scoped invitation seen from the browser.
 *
 * The assertions worth having here are not "does it work" - the database
 * decides that - but what the client is allowed to learn and where it is
 * allowed to send it.
 */

const TEAM_URL = 'https://team-api.vishartattoo.com/v1/staff/invite';
// The Worker routes on the body shape because a zone WAF rule permits only
// this one path. See the comment in api.ts.
const ARTIST_URL = TEAM_URL;

function client(rpcResult: unknown = { can_invite: true }) {
  return {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'synthetic.token' } }, error: null }),
    },
    rpc: async () => ({ data: rpcResult, error: null }),
  } as any;
}

const invite = {
  idempotency_key: '88888888-8888-4888-8888-888888888888',
  email: 'new.teammate@example.test',
  display_name: 'New Teammate',
  artist_id: 'a1111111-1111-4111-8111-111111111111',
  grant: {
    access_level: 'manager' as const,
    can_view_finance: false,
    can_manage_finance: false,
    can_manage_sessions: true,
    can_manage_integrations: false,
  },
};

describe('tenant-scoped teammate invitation', () => {
  it('posts to the one endpoint the edge permits', async () => {
    const fetcher = vi.fn(async (url: any) => {
      expect(String(url)).toBe(ARTIST_URL);
      return new Response(JSON.stringify({ delivery: 'sent', idempotent_replay: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const api = createApi(client(), { teamInviteUrl: TEAM_URL, fetcher: fetcher as any });
    await expect(api.inviteTeammate(invite)).resolves.toEqual({
      delivery: 'sent',
      idempotent_replay: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('carries the caller session and nothing the caller did not choose', async () => {
    let seen: any = null;
    const fetcher = vi.fn(async (_url: any, init: any) => {
      seen = init;
      return new Response(JSON.stringify({ delivery: 'sent', idempotent_replay: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const api = createApi(client(), { teamInviteUrl: TEAM_URL, fetcher: fetcher as any });
    await api.inviteTeammate(invite);

    expect(seen.headers.authorization).toBe('Bearer synthetic.token');
    const body = JSON.parse(seen.body);
    // No role and no membership array exist on this path at all.
    expect('role' in body).toBe(false);
    expect('memberships' in body).toBe(false);
    expect(body.artist_id).toBe(invite.artist_id);
  });

  it('returns nothing beyond delivery, so it cannot report who already exists', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      delivery: 'sent',
      idempotent_replay: true,
      profile_id: '99999999-9999-4999-8999-999999999999',
      email: 'somebody@example.test',
      leaked: 'must-not-be-copied',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const api = createApi(client(), { teamInviteUrl: TEAM_URL, fetcher: fetcher as any });
    const result = await api.inviteTeammate(invite);
    expect(result).toEqual({ delivery: 'sent', idempotent_replay: true });
    expect(Object.keys(result).sort()).toEqual(['delivery', 'idempotent_replay']);
  });

  it('refuses a response shape it does not recognise', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ delivery: 'existing_account' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const api = createApi(client(), { teamInviteUrl: TEAM_URL, fetcher: fetcher as any });
    await expect(api.inviteTeammate(invite)).rejects.toThrow();
  });

  it('is unavailable when the team endpoint is not configured', async () => {
    const fetcher = vi.fn();
    const api = createApi(client(), { fetcher: fetcher as any });
    await expect(api.inviteTeammate(invite)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports the button as unavailable when the policy read fails', async () => {
    const failing = {
      auth: { getSession: async () => ({ data: { session: null }, error: null }) },
      rpc: async () => ({ data: null, error: { message: 'denied' } }),
    } as any;
    const api = createApi(failing, { teamInviteUrl: TEAM_URL });
    await expect(api.tenantInvitePolicy(invite.artist_id)).resolves.toEqual({ can_invite: false });
  });
});
