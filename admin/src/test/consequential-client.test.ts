import { describe, expect, it, vi } from 'vitest';
import { withConsequentialConfirmations } from '../lib/consequential-client';
import { createFakeClient } from './fixtures';

function wrappedClient(
  confirm: (message: string) => boolean,
  rpcCalls: { name: string; args: Record<string, unknown> | undefined }[],
  language: 'en' | 'ru' = 'en'
) {
  const client = createFakeClient({ role: 'owner', rpcCalls });
  const wrapped = withConsequentialConfirmations(client, {
    confirm,
    language: () => language,
  });
  if (!wrapped) throw new Error('Expected a configured client');
  return wrapped;
}

describe('consequential RPC confirmations', () => {
  it('does not send enquiry conversion when confirmation is declined', async () => {
    const confirm = vi.fn(() => false);
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const client = wrappedClient(confirm, rpcCalls);

    const result = await client.rpc('convert_enquiry_to_project', {
      p_enquiry_id: 'enquiry-id',
      p_title: 'Tattoo',
      p_description: null,
    });

    expect(result).toEqual({ data: null, error: null });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/cannot be undone/i));
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ['cancelled', /active schedule/i],
    ['no_show', /did not attend/i],
  ])('guards the %s session state', async (status, expectedMessage) => {
    const confirm = vi.fn(() => false);
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const client = wrappedClient(confirm, rpcCalls);

    await client.rpc('set_session_status', {
      p_session_id: 'session-id',
      p_status: status,
    });

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(expectedMessage));
    expect(rpcCalls).toEqual([]);
  });

  it('guards user deactivation but not reactivation', async () => {
    const confirm = vi.fn(() => false);
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const client = wrappedClient(confirm, rpcCalls);

    await client.rpc('set_profile_active', {
      p_profile_id: 'profile-id',
      p_is_active: false,
    });
    expect(rpcCalls).toEqual([]);

    await client.rpc('set_profile_active', {
      p_profile_id: 'profile-id',
      p_is_active: true,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toContainEqual({
      name: 'set_profile_active',
      args: { p_profile_id: 'profile-id', p_is_active: true },
    });
  });

  it('passes ordinary session workflow states without a prompt', async () => {
    const confirm = vi.fn(() => false);
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const client = wrappedClient(confirm, rpcCalls);

    await client.rpc('set_session_status', {
      p_session_id: 'session-id',
      p_status: 'confirmed',
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(rpcCalls).toContainEqual({
      name: 'set_session_status',
      args: { p_session_id: 'session-id', p_status: 'confirmed' },
    });
  });

  it('sends a consequential RPC after confirmation', async () => {
    const confirm = vi.fn(() => true);
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const client = wrappedClient(confirm, rpcCalls);

    await client.rpc('set_session_status', {
      p_session_id: 'session-id',
      p_status: 'cancelled',
    });

    expect(rpcCalls).toContainEqual({
      name: 'set_session_status',
      args: { p_session_id: 'session-id', p_status: 'cancelled' },
    });
  });

  it('uses the selected Russian language for confirmation copy', async () => {
    const confirm = vi.fn(() => false);
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const client = wrappedClient(confirm, rpcCalls, 'ru');

    await client.rpc('set_session_status', {
      p_session_id: 'session-id',
      p_status: 'no_show',
    });

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/клиент не пришёл/i));
  });

  it('keeps an unconfigured client unconfigured', () => {
    expect(withConsequentialConfirmations(null)).toBeNull();
  });
});
