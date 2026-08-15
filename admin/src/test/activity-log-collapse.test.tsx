import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CollapsibleActivityLog } from '../components/CollapsibleActivityLog';
import type { ActivityEntry } from '../lib/types';

const ACTIVITY: ActivityEntry[] = [
  {
    id: 'activity-newest',
    artist_id: 'a1111111-1111-4111-8111-111111111111',
    occurred_at: '2026-08-15T09:00:00Z',
    event_type: 'enquiry.reference_uploaded',
    actor_kind: 'profile',
    actor_profile_id: '11111111-1111-4111-8111-111111111111',
    client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    enquiry_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    project_id: null,
    session_id: null,
    metadata: {},
  },
  {
    id: 'activity-middle',
    artist_id: 'a1111111-1111-4111-8111-111111111111',
    occurred_at: '2026-08-15T08:00:00Z',
    event_type: 'note.created',
    actor_kind: 'profile',
    actor_profile_id: '11111111-1111-4111-8111-111111111111',
    client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    enquiry_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    project_id: null,
    session_id: null,
    metadata: {},
  },
  {
    id: 'activity-oldest',
    artist_id: 'a1111111-1111-4111-8111-111111111111',
    occurred_at: '2026-08-15T07:00:00Z',
    event_type: 'enquiry.manual_created',
    actor_kind: 'profile',
    actor_profile_id: '11111111-1111-4111-8111-111111111111',
    client_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    enquiry_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    project_id: null,
    session_id: null,
    metadata: {},
  },
];

describe('collapsible activity log', () => {
  it('shows only the newest action until the log is expanded, then collapses again', () => {
    render(<CollapsibleActivityLog activity={ACTIVITY} />);

    expect(screen.getByTitle('enquiry.reference_uploaded')).toBeInTheDocument();
    expect(screen.queryByTitle('note.created')).not.toBeInTheDocument();
    expect(screen.queryByTitle('enquiry.manual_created')).not.toBeInTheDocument();

    const expand = screen.getByRole('button', { name: 'Expand activity log' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);

    expect(screen.getByTitle('enquiry.reference_uploaded')).toBeInTheDocument();
    expect(screen.getByTitle('note.created')).toBeInTheDocument();
    expect(screen.getByTitle('enquiry.manual_created')).toBeInTheDocument();

    const collapse = screen.getByRole('button', { name: 'Collapse activity log' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(collapse);

    expect(screen.getByTitle('enquiry.reference_uploaded')).toBeInTheDocument();
    expect(screen.queryByTitle('note.created')).not.toBeInTheDocument();
    expect(screen.queryByTitle('enquiry.manual_created')).not.toBeInTheDocument();
  });

  it('does not show a toggle for a one-entry log', () => {
    render(<CollapsibleActivityLog activity={ACTIVITY.slice(0, 1)} />);

    expect(screen.getByTitle('enquiry.reference_uploaded')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
