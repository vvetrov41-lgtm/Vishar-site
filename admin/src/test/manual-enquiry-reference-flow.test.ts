import { describe, expect, it, vi } from 'vitest';
import {
  createManualEnquiryWithReferences,
  ManualReferenceUploadError,
} from '../lib/manual-enquiry-reference-flow';
import type { ManualEnquiryRequest, ManualEnquiryResult } from '../lib/manual-intake-api';

const REQUEST: ManualEnquiryRequest = {
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  artistId: 'a1111111-1111-4111-8111-111111111111',
  fullName: 'Synthetic Client',
  email: 'synthetic@example.test',
  phone: '',
  instagram: '',
  preferredContact: 'Email',
  travellingFrom: 'UK',
  projectType: 'Black and grey realism',
  placement: 'Forearm',
  approximateSize: '20 cm',
  coverUp: 'No',
  preferredTiming: 'November',
  idea: 'Synthetic test enquiry.',
  privacyAcknowledged: true,
};

const RESULT: ManualEnquiryResult = {
  enquiry_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  reference_number: 'ENQ-2026-0099',
  intake_state: 'complete',
  replayed: false,
  client_conflict: false,
  client_match_method: 'created',
};

function reference(name: string) {
  return new File(['synthetic-image'], name, { type: 'image/jpeg' });
}

describe('manual enquiry reference flow', () => {
  it('creates the enquiry before uploading selected references in order', async () => {
    const calls: string[] = [];
    const api = {
      createManualEnquiry: vi.fn(async () => {
        calls.push('create');
        return RESULT;
      }),
      addEnquiryReference: vi.fn(async (_enquiryId: string, file: File) => {
        calls.push(`upload:${file.name}`);
        return { ok: true };
      }),
    };

    await expect(createManualEnquiryWithReferences(
      api,
      REQUEST,
      [reference('one.jpg'), reference('two.jpg')]
    )).resolves.toEqual(RESULT);

    expect(calls).toEqual(['create', 'upload:one.jpg', 'upload:two.jpg']);
    expect(api.addEnquiryReference).toHaveBeenNthCalledWith(1, RESULT.enquiry_id, expect.any(File));
    expect(api.addEnquiryReference).toHaveBeenNthCalledWith(2, RESULT.enquiry_id, expect.any(File));
  });

  it('preserves the created enquiry identity when a reference upload fails', async () => {
    const api = {
      createManualEnquiry: vi.fn(async () => RESULT),
      addEnquiryReference: vi.fn(async () => { throw new Error('synthetic upload failure'); }),
    };

    try {
      await createManualEnquiryWithReferences(api, REQUEST, [reference('one.jpg')]);
      throw new Error('expected upload failure');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ManualReferenceUploadError);
      expect((cause as ManualReferenceUploadError).enquiry).toEqual(RESULT);
    }
    expect(api.createManualEnquiry).toHaveBeenCalledTimes(1);
  });
});
