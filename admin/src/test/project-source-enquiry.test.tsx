import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { App } from '../App';
import { PROJECT_ID, renderWithSession } from './fixtures';

describe('project keeps the original request', () => {
  it('shows the client words and enquiry facts on the project page after conversion', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/projects/${PROJECT_ID}` });
    const source = await screen.findByTestId('project-source-enquiry');
    expect(within(source).getByText('Colour realism')).toBeInTheDocument();
    expect(within(source).getByText('A realistic raven with natural lighting.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Original request' })).toBeInTheDocument();
  });
});
