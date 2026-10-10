// One description of what the client asked for, shared by every list.
//
// Booking form v2 enquiries carry project_summary, generated in the database
// from project_details ("Full sleeve + Forearm cover-up + Leg tattoo"). Legacy
// enquiries have no summary and keep their original type and placement text.

import type { Enquiry } from './types';

type SummaryFields = Pick<Enquiry, 'project_type' | 'placement'> & { project_summary?: string | null };

/** Short title: the structured summary, else the legacy project type. */
export function enquiryHeadline(enquiry: SummaryFields): string | null {
  return enquiry.project_summary || enquiry.project_type || null;
}

/** One-line brief for cards: the summary already names the placements. */
export function enquiryBrief(enquiry: SummaryFields): string {
  if (enquiry.project_summary) return enquiry.project_summary;
  return [enquiry.project_type, enquiry.placement].filter(Boolean).join(' · ');
}
