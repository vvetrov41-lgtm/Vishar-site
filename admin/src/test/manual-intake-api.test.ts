import { describe, expect, it, vi } from 'vitest';
import type { CrmClient } from '../lib/api';
import { createManualIntakeApi } from '../lib/manual-intake-api';

const RESULT = {
  enquiry_id: '11111111-1111-4111-8111-111111111111',
  client_id: '22222222-2222-4222-8222-222222222222',
  reference_number: 'ENQ-2026-0999',
  intake_state: 'complete',
  replayed: false,
  client_conflict: false,
  client_match_method: 'created',
};

describe('manual CRM intake API', () => {
  it('calls only the named artist-scoped RPC with a bounded payload', async () => {
    const rpc = vi.fn(async () => ({ data: RESULT, error: null }));
    const api = createManualIntakeApi({ rpc } as unknown as CrmClient);

    await expect(api.createManualEnquiry({
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
      artistId: 'a1111111-1111-4111-8111-111111111111',
      fullName: '  Manual Client  ',
      email: ' manual@example.test ',
      phone: '',
      instagram: ' @manual ',
      preferredContact: 'Email',
      travellingFrom: '',
      projectType: ' Tattoo ',
      placement: ' Forearm ',
      approximateSize: '',
      coverUp: '',
      preferredTiming: '',
      idea: ' Synthetic brief ',
      privacyAcknowledged: true,
    })).resolves.toEqual(RESULT);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('create_manual_enquiry', {
      p_idempotency_key: '33333333-3333-4333-8333-333333333333',
      p_artist_id: 'a1111111-1111-4111-8111-111111111111',
      p_client: {
        full_name: 'Manual Client',
        email: 'manual@example.test',
        phone: null,
        instagram: '@manual',
        preferred_contact: 'Email',
        travelling_from: null,
      },
      p_enquiry: {
        project_type: 'Tattoo',
        placement: 'Forearm',
        approximate_size: null,
        cover_up: null,
        preferred_timing: null,
        idea: 'Synthetic brief',
      },
      p_privacy_acknowledged: true,
    });
  });

  it('maps an RLS/RPC denial to a safe permission message', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: '42501', message: 'artist access is not permitted' },
    }));
    const api = createManualIntakeApi({ rpc } as unknown as CrmClient);

    await expect(api.createManualEnquiry({
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      artistId: 'a2222222-2222-4222-8222-222222222222',
      fullName: 'Denied',
      email: 'denied@example.test',
      privacyAcknowledged: true,
    })).rejects.toThrow('You do not have permission to create that manual enquiry.');
  });

  it('rejects an unexpected RPC response shape', async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
    const api = createManualIntakeApi({ rpc } as unknown as CrmClient);

    await expect(api.createManualEnquiry({
      idempotencyKey: '55555555-5555-4555-8555-555555555555',
      artistId: 'a1111111-1111-4111-8111-111111111111',
      fullName: 'Malformed',
      email: 'malformed@example.test',
      privacyAcknowledged: true,
    })).rejects.toThrow('invalid response');
  });
});
