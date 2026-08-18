import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import {
  showConsequentialDialog,
  withConsequentialConfirmations,
} from '../lib/consequential-client';
import { createFakeClient } from './fixtures';

function wrappedClient(
  confirm: (message: string) => boolean | Promise<boolean>,
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
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/cannot be undone/i),
      'convertEnquiry',
      'en'
    );
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ['archive_enquiry', 'archiveEnquiry', /retained for audit and recovery/i],
    ['archive_client', 'archiveClient', /unconverted enquiries/i],
  ] as const)('guards %s before the RPC is sent', async (rpcName, action, expectedMessage) => {
    const confirm = vi.fn(() => false);
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const client = wrappedClient(confirm, rpcCalls);

    const result = await client.rpc(rpcName, {
      [rpcName === 'archive_enquiry' ? 'p_enquiry_id' : 'p_client_id']: 'record-id',
    });

    expect(result).toEqual({ data: null, error: null });
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(expectedMessage),
      action,
      'en'
    );
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

    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(expectedMessage),
      status === 'cancelled' ? 'cancelSession' : 'markNoShow',
      'en'
    );
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ['cancelled', 'cancelAppointment'],
    ['no_show', 'markAppointmentNoShow'],
  ] as const)('guards the %s appointment state', async (status, action) => {
    const confirm = vi.fn(() => false);
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    const client = wrappedClient(confirm, rpcCalls);

    await client.rpc('set_appointment_status', {
      p_appointment_id: 'appointment-id',
      p_status: status,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/appointment/i),
      action,
      'en'
    );
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

  it('sends a consequential RPC after asynchronous confirmation', async () => {
    const confirm = vi.fn(async () => true);
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

    await client.rpc('archive_client', {
      p_client_id: 'client-id',
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/сохранятся для аудита и восстановления/i),
      'archiveClient',
      'ru'
    );
  });

  it('shows a CRM-owned modal with a safe cancel path', async () => {
    document.body.style.overflow = 'auto';
    const decision = showConsequentialDialog(
      'Cancel this session? It will be removed from the active schedule.',
      'cancelSession',
      'en'
    );

    expect(screen.getByRole('alertdialog', { name: 'Cancel session?' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('button', { name: 'Cancel session' })).toHaveClass('danger');

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

    await expect(decision).resolves.toBe(false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('keeps an unconfigured client unconfigured', () => {
    expect(withConsequentialConfirmations(null)).toBeNull();
  });
});
