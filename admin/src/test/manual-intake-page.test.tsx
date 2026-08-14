import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { App } from '../App';
import { renderWithSession } from './fixtures';

describe('manual enquiry UI boundary', () => {
  it('offers manual enquiry entry to a booking manager', async () => {
    renderWithSession(<App />, { role: 'booking_manager', path: '/enquiries' });
    expect(await screen.findByText('New manual enquiry')).toBeInTheDocument();
  });

  it('offers manual enquiry entry to the owner', async () => {
    renderWithSession(<App />, { role: 'owner', path: '/enquiries' });
    expect(await screen.findByText('New manual enquiry')).toBeInTheDocument();
  });

  it('does not offer a manual write control to read-only staff', async () => {
    renderWithSession(<App />, { role: 'read_only', path: '/enquiries' });
    await screen.findByLabelText(/search/i);
    expect(screen.queryByText('New manual enquiry')).not.toBeInTheDocument();
  });
});
