import type { ManualEnquiryRequest, ManualEnquiryResult } from './manual-intake-api';

export interface ManualEnquiryReferenceApi {
  createManualEnquiry(request: ManualEnquiryRequest): Promise<ManualEnquiryResult>;
  addEnquiryReference(enquiryId: string, file: File): Promise<unknown>;
}

export class ManualReferenceUploadError extends Error {
  readonly enquiry: ManualEnquiryResult;

  constructor(enquiry: ManualEnquiryResult, cause: unknown) {
    super('The enquiry was created, but one or more reference images could not be uploaded.');
    this.name = 'ManualReferenceUploadError';
    this.enquiry = enquiry;
    if (cause instanceof Error) this.cause = cause;
  }
}

export async function createManualEnquiryWithReferences(
  api: ManualEnquiryReferenceApi,
  request: ManualEnquiryRequest,
  references: readonly File[]
): Promise<ManualEnquiryResult> {
  const enquiry = await api.createManualEnquiry(request);

  try {
    for (const reference of references) {
      await api.addEnquiryReference(enquiry.enquiry_id, reference);
    }
  } catch (cause) {
    throw new ManualReferenceUploadError(enquiry, cause);
  }

  return enquiry;
}
