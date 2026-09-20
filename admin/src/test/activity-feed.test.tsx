import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ActivityFeed } from '../components/ActivityFeed';
import { ENQUIRY_ID, renderWithSession } from './fixtures';

describe('paginated activity feed', () => {
  it('reads bounded server pages and advances the range on Load more', async () => {
    const queryCalls: { table: string; method: string; args: unknown[] }[] = [];

    renderWithSession(
      <ActivityFeed filter={{ enquiryId: ENQUIRY_ID }} pageSize={1} />,
      { role: 'owner', path: '/activity', queryCalls },
    );

    expect(await screen.findByText('Enquiry created')).toBeInTheDocument();

    await waitFor(() => {
      expect(queryCalls.find(
        (call) => call.table === 'activity_log'
          && call.method === 'range'
          && call.args[0] === 0
          && call.args[1] === 0,
      )).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => {
      expect(queryCalls.find(
        (call) => call.table === 'activity_log'
          && call.method === 'range'
          && call.args[0] === 1
          && call.args[1] === 1,
      )).toBeTruthy();
    });

    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('keeps collapsed detail history compact until the operator opens it', async () => {
    renderWithSession(
      <ActivityFeed filter={{ enquiryId: ENQUIRY_ID }} pageSize={1} initiallyCollapsed />,
      { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` },
    );

    expect(await screen.findByText('Enquiry created')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show history' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });
});
