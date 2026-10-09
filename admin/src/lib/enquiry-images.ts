// Grouping of enquiry images by what the client said they show.
//
// Booking form v2 intake images carry intake_role; legacy intake and staff
// uploads do not and stay in one unlabelled group, exactly as before.

import type { EnquiryFile } from './types';

export type ImageGroupKey = 'design' | 'existing' | 'other';

export function imageGroups(files: EnquiryFile[]): Array<{
  key: ImageGroupKey;
  titleKey: 'enquiry.designReferences' | 'enquiry.existingTattooPhotos' | 'enquiry.otherImages' | null;
  files: EnquiryFile[];
}> {
  const design = files.filter((file) => file.intake_role === 'design_reference');
  const existing = files.filter((file) => file.intake_role === 'existing_tattoo');
  const other = files.filter((file) => !file.intake_role);
  if (design.length === 0 && existing.length === 0) return [{ key: 'other', titleKey: null, files: other }];
  return [
    { key: 'existing' as const, titleKey: 'enquiry.existingTattooPhotos' as const, files: existing },
    { key: 'design' as const, titleKey: 'enquiry.designReferences' as const, files: design },
    { key: 'other' as const, titleKey: 'enquiry.otherImages' as const, files: other },
  ].filter((group) => group.files.length > 0);
}
