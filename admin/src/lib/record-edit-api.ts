import { ApiError, friendlyMessage, type CrmClient } from './api';
import type { EnquiryFile } from './types';

export interface ClientDetailsUpdate {
  fullName: string;
  email: string | null;
  phone: string | null;
  instagram: string | null;
  preferredContact: string | null;
  travellingFrom: string | null;
}

export interface EnquiryDetailsUpdate {
  projectType: string | null;
  placement: string | null;
  approximateSize: string | null;
  coverUp: string | null;
  preferredTiming: string | null;
  idea: string | null;
}

interface PreparedReference {
  file_id: string;
  enquiry_id: string;
  ordinal: number;
  storage_path: string;
  mime_type: string;
  byte_size: number;
}

type StorageBucket = ReturnType<CrmClient['storage']['from']> & {
  upload: (
    path: string,
    body: File,
    options: { contentType: string; upsert: boolean }
  ) => Promise<{ data: unknown; error: any }>;
  remove: (paths: string[]) => Promise<{ data: unknown; error: any }>;
};

function trimOrNull(value: string | null | undefined) {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rpcResult<T>(result: { data: any; error: any }, action: string): T {
  if (result.error) {
    throw new ApiError(friendlyMessage(result.error, action), result.error);
  }
  return result.data as T;
}

function archiveResult<T>(
  result: { data: any; error: any },
  record: 'client' | 'enquiry'
): T | null {
  if (result.error) {
    if (result.error?.code === '55000') {
      const message = record === 'client'
        ? 'This client has an active project. Archive or close that project before deleting the client.'
        : 'This enquiry has an active project. Archive or close that project before deleting the enquiry.';
      throw new ApiError(message, result.error);
    }
    throw new ApiError(friendlyMessage(result.error, `delete that ${record}`), result.error);
  }
  return (result.data ?? null) as T | null;
}

function storageError(error: any, action: string) {
  if (!error) return;
  throw new ApiError(`Could not ${action}. Please try again.`, error);
}

export function createRecordEditApi(client: CrmClient) {
  const bucket = client.storage.from('crm-files') as StorageBucket;

  return {
    async updateClientDetails(clientId: string, input: ClientDetailsUpdate) {
      return rpcResult(
        await client.rpc('update_client_details', {
          p_client_id: clientId,
          p_client: {
            full_name: input.fullName.trim(),
            email: trimOrNull(input.email),
            phone: trimOrNull(input.phone),
            instagram: trimOrNull(input.instagram),
            preferred_contact: trimOrNull(input.preferredContact),
            travelling_from: trimOrNull(input.travellingFrom),
          },
        }),
        'update that client'
      );
    },

    async archiveClient(clientId: string) {
      return archiveResult(
        await client.rpc('update_client_details', {
          p_client_id: clientId,
          p_client: { _archive: true },
        }),
        'client'
      );
    },

    async updateEnquiryDetails(enquiryId: string, input: EnquiryDetailsUpdate) {
      return rpcResult(
        await client.rpc('update_enquiry_details', {
          p_enquiry_id: enquiryId,
          p_enquiry: {
            project_type: trimOrNull(input.projectType),
            placement: trimOrNull(input.placement),
            approximate_size: trimOrNull(input.approximateSize),
            cover_up: trimOrNull(input.coverUp),
            preferred_timing: trimOrNull(input.preferredTiming),
            idea: trimOrNull(input.idea),
          },
        }),
        'update that enquiry'
      );
    },

    async archiveEnquiry(enquiryId: string) {
      return archiveResult(
        await client.rpc('update_enquiry_details', {
          p_enquiry_id: enquiryId,
          p_enquiry: { _archive: true },
        }),
        'enquiry'
      );
    },

    async addEnquiryReference(enquiryId: string, file: File): Promise<PreparedReference> {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        throw new ApiError('Only JPG, PNG or WebP reference images are allowed.');
      }
      if (file.size <= 0 || file.size > 4 * 1024 * 1024) {
        throw new ApiError('Reference images must be no larger than 4 MB.');
      }

      const prepared = rpcResult<PreparedReference>(
        await client.rpc('prepare_enquiry_reference_upload', {
          p_enquiry_id: enquiryId,
          p_original_filename: file.name,
          p_mime_type: file.type,
          p_byte_size: file.size,
        }),
        'prepare that reference image'
      );

      const uploaded = await bucket.upload(prepared.storage_path, file, {
        contentType: file.type,
        upsert: false,
      });

      if (uploaded.error) {
        // Upload failure should not consume one of the three manifest slots.
        // This cleanup is deliberately best-effort: if Storage actually wrote
        // the object, the RPC refuses to erase its manifest and leaves a
        // reconcilable pending row instead of creating an orphan.
        await client.rpc('cancel_enquiry_reference_upload', { p_file_id: prepared.file_id });
        storageError(uploaded.error, 'upload that reference image');
      }

      rpcResult(
        await client.rpc('finalize_enquiry_reference_upload', { p_file_id: prepared.file_id }),
        'finalize that reference image'
      );

      return prepared;
    },

    async finalizeEnquiryReference(fileId: string) {
      return rpcResult(
        await client.rpc('finalize_enquiry_reference_upload', { p_file_id: fileId }),
        'finalize that reference image'
      );
    },

    async removeEnquiryReference(file: Pick<EnquiryFile, 'id' | 'storage_path'>) {
      const removed = await bucket.remove([file.storage_path]);
      storageError(removed.error, 'remove that reference image');
      return rpcResult(
        await client.rpc('remove_enquiry_reference_manifest', { p_file_id: file.id }),
        'remove that reference image'
      );
    },
  };
}

export type RecordEditApi = ReturnType<typeof createRecordEditApi>;
