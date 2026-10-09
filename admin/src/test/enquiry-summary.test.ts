import { describe, expect, it } from 'vitest';
import { enquiryBrief, enquiryHeadline } from '../lib/enquiry-summary';

describe('enquiry summary for lists', () => {
  const structured = {
    project_type: 'Cover-up',
    placement: 'Arm: Full sleeve, Forearm; Leg: Calf',
    project_summary: 'Full sleeve + Forearm cover-up + Leg tattoo',
  };

  it('shows the whole structured project, not just the derived type', () => {
    expect(enquiryHeadline(structured)).toBe('Full sleeve + Forearm cover-up + Leg tattoo');
    expect(enquiryBrief(structured)).toBe('Full sleeve + Forearm cover-up + Leg tattoo');
  });

  it('keeps legacy enquiries exactly as before', () => {
    const legacy = { project_type: 'Cover-up', placement: 'Forearm', project_summary: null };
    expect(enquiryHeadline(legacy)).toBe('Cover-up');
    expect(enquiryBrief(legacy)).toBe('Cover-up · Forearm');
    expect(enquiryHeadline({ project_type: null, placement: null })).toBeNull();
    expect(enquiryBrief({ project_type: null, placement: null })).toBe('');
  });
});
