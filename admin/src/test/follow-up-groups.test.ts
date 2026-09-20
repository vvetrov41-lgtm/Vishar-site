import { describe, expect, it } from 'vitest';
import { followUpHref, groupFollowUps } from '../lib/follow-up-groups';
import type { FollowUp } from '../lib/types';

function followUp(
  id: string,
  dueAt: string,
  status: FollowUp['status'] = 'open',
  artistId = 'artist-london',
): FollowUp {
  return {
    id,
    artist_id: artistId,
    status,
    due_at: dueAt,
    subject: id,
    details: null,
    client_id: 'client-1',
    enquiry_id: null,
    project_id: null,
    assigned_to: null,
  };
}

describe('follow-up grouping', () => {
  it('groups by each artist local calendar day rather than the browser timezone', () => {
    const due = '2026-09-21T05:00:00Z';
    const groups = groupFollowUps(
      [
        followUp('london', due, 'open', 'artist-london'),
        followUp('new-york', due, 'open', 'artist-new-york'),
      ],
      new Date('2026-09-20T23:30:00Z'),
      {
        'artist-london': 'Europe/London',
        'artist-new-york': 'America/New_York',
      },
    );

    expect(groups.today.map((row) => row.id)).toEqual(['london']);
    expect(groups.tomorrow.map((row) => row.id)).toEqual(['new-york']);
  });

  it('separates overdue, today, tomorrow, this week, later and completed work', () => {
    const groups = groupFollowUps(
      [
        followUp('overdue', '2026-09-15T12:00:00Z'),
        followUp('today', '2026-09-16T18:00:00Z'),
        followUp('tomorrow', '2026-09-17T09:00:00Z'),
        followUp('week', '2026-09-20T09:00:00Z'),
        followUp('later', '2026-09-21T09:00:00Z'),
        followUp('done', '2026-09-14T09:00:00Z', 'done'),
      ],
      new Date('2026-09-16T12:00:00Z'),
      { 'artist-london': 'Europe/London' },
    );

    expect(groups.overdue.map((row) => row.id)).toEqual(['overdue']);
    expect(groups.today.map((row) => row.id)).toEqual(['today']);
    expect(groups.tomorrow.map((row) => row.id)).toEqual(['tomorrow']);
    expect(groups.this_week.map((row) => row.id)).toEqual(['week']);
    expect(groups.later.map((row) => row.id)).toEqual(['later']);
    expect(groups.completed.map((row) => row.id)).toEqual(['done']);
  });

  it('opens the most specific working context', () => {
    const row = followUp('routing', '2026-09-20T09:00:00Z');
    row.enquiry_id = 'enquiry-1';
    row.project_id = 'project-1';
    row.client_id = 'client-1';

    expect(followUpHref(row)).toBe('/enquiries/enquiry-1');
    row.enquiry_id = null;
    expect(followUpHref(row)).toBe('/projects/project-1');
    row.project_id = null;
    expect(followUpHref(row)).toBe('/clients/client-1');
  });
});
