import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { App } from '../App';
import { ENQUIRY, ENQUIRY_ID, renderWithSession } from './fixtures';

type DiscoveryFixture = typeof ENQUIRY & {
  discovery_source?: string | null;
  discovery_source_detail?: string | null;
};

const enquiry = ENQUIRY as DiscoveryFixture;
const initialSource = enquiry.discovery_source;
const initialDetail = enquiry.discovery_source_detail;

afterEach(() => {
  enquiry.discovery_source = initialSource;
  enquiry.discovery_source_detail = initialDetail;
});

describe('enquiry discovery source', () => {
  it('shows the client-reported acquisition source in the enquiry summary', async () => {
    enquiry.discovery_source = 'instagram';
    enquiry.discovery_source_detail = null;

    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });

    const sourceLabel = await screen.findByText('How they found you');
    expect(sourceLabel.nextElementSibling).toHaveTextContent('Instagram');
  });

  it('shows the optional source detail next to the normalised category', async () => {
    enquiry.discovery_source = 'referral';
    enquiry.discovery_source_detail = 'Sarah';

    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });

    expect(await screen.findByText('Recommendation / Friend · Sarah')).toBeInTheDocument();
  });
});
