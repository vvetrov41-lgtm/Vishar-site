import { describe, expect, it } from 'vitest';
import { createRecordEditApi } from '../lib/record-edit-api';
import type { CrmClient } from '../lib/api';

function harness(options: { uploadError?: any } = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> | undefined }> = [];
  const uploads: Array<{ path: string; file: File; options: unknown }> = [];
  const removals: string[][] = [];

  const client = {
    rpc: async (name: string, args?: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === 'prepare_enquiry_reference_upload') {
        return {
          data: {
            file_id: 'f0000000-0000-4000-8000-000000000001',
            enquiry_id: 'e0000000-0000-4000-8000-000000000001',
            ordinal: 0,
            storage_path: 'clients/c/enquiries/e/references/f.jpg',
            mime_type: 'image/jpeg',
            byte_size: 3,
          },
          error: null,
        };
      }
      return { data: { ok: true }, error: null };
    },
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: null, error: null }),
        upload: async (path: string, file: File, uploadOptions: unknown) => {
          uploads.push({ path, file, options: uploadOptions });
          return { data: options.uploadError ? null : { path }, error: options.uploadError ?? null };
        },
        remove: async (paths: string[]) => {
          removals.push(paths);
          return { data: paths, error: null };
        },
      }),
    },
  } as unknown as CrmClient;

  return { api: createRecordEditApi(client), rpcCalls, uploads, removals };
}

describe('record edit API', () => {
  it('updates canonical client details only through the named RPC', async () => {
    const { api, rpcCalls } = harness();

    await api.updateClientDetails('client-1', {
      fullName: 'Zena Adii',
      email: ' zee@example.test ',
      phone: ' +447900000000 ',
      instagram: ' zenaadii ',
      preferredContact: 'WhatsApp',
      travellingFrom: ' UK ',
    });

    expect(rpcCalls).toEqual([{
      name: 'update_client_details',
      args: {
        p_client_id: 'client-1',
        p_client: {
          full_name: 'Zena Adii',
          email: 'zee@example.test',
          phone: '+447900000000',
          instagram: 'zenaadii',
          preferred_contact: 'WhatsApp',
          travelling_from: 'UK',
        },
      },
    }]);
  });

  it('updates enquiry project details through the named RPC', async () => {
    const { api, rpcCalls } = harness();

    await api.updateEnquiryDetails('enquiry-1', {
      projectType: 'Black & Grey Realism',
      placement: 'Outer forearm',
      approximateSize: null,
      coverUp: 'No',
      preferredTiming: 'November',
      idea: 'Aphrodite and Kenyan shield',
    });

    expect(rpcCalls[0].name).toBe('update_enquiry_details');
    expect(rpcCalls[0].args?.p_enquiry_id).toBe('enquiry-1');
  });

  it('creates the manifest before uploading and finalizes only after Storage succeeds', async () => {
    const { api, rpcCalls, uploads } = harness();
    const file = new File([new Uint8Array([1, 2, 3])], 'reference.jpg', { type: 'image/jpeg' });

    await api.addEnquiryReference('e0000000-0000-4000-8000-000000000001', file);

    expect(rpcCalls.map((call) => call.name)).toEqual([
      'prepare_enquiry_reference_upload',
      'finalize_enquiry_reference_upload',
    ]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe('clients/c/enquiries/e/references/f.jpg');
    expect(uploads[0].options).toEqual({ contentType: 'image/jpeg', upsert: false });
  });

  it('best-effort cancels the pending manifest when Storage upload fails', async () => {
    const { api, rpcCalls } = harness({ uploadError: { message: 'upload failed' } });
    const file = new File([new Uint8Array([1])], 'reference.jpg', { type: 'image/jpeg' });

    await expect(api.addEnquiryReference('enquiry-1', file)).rejects.toThrow(/Could not upload/i);
    expect(rpcCalls.map((call) => call.name)).toEqual([
      'prepare_enquiry_reference_upload',
      'cancel_enquiry_reference_upload',
    ]);
  });

  it('removes the private object before deleting its manifest', async () => {
    const { api, rpcCalls, removals } = harness();

    await api.removeEnquiryReference({ id: 'file-1', storage_path: 'private/path.jpg' });

    expect(removals).toEqual([['private/path.jpg']]);
    expect(rpcCalls.at(-1)).toEqual({
      name: 'remove_enquiry_reference_manifest',
      args: { p_file_id: 'file-1' },
    });
  });
});
