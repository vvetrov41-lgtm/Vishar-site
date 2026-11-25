import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { App } from '../App';
import { EnquiryProjectDetails } from '../components/EnquiryProjectDetails';
import { ENQUIRY, ENQUIRY_FILE, ENQUIRY_ID, renderWithSession } from './fixtures';
import type { EnquiryProjectDetails as Details } from '../lib/types';

const enquiry = ENQUIRY as typeof ENQUIRY & { project_details?: Details | null };
const file = ENQUIRY_FILE as typeof ENQUIRY_FILE & { intake_role?: string | null };

const DETAILS: Details = {
  schema: 'enquiry-v2',
  areas: [
    { region: 'Arm', placements: ['Full sleeve', 'Forearm'], work: ['New tattoo'] },
    { region: 'Leg', placements: ['Other'], otherPlacement: 'Back of the knee', work: ['Cover-up', 'Rework'] },
  ],
  styles: ['Black & Grey realism', 'Colour realism'],
  sizeNotes: 'Whole left arm',
  existingDetails: 'Old tribal on the calf',
};

afterEach(() => {
  delete enquiry.project_details;
  delete file.intake_role;
});

describe('booking form v2 project details', () => {
  it('lists every area with its own work types, styles and client text', () => {
    render(<EnquiryProjectDetails details={DETAILS} language="en" />);
    const block = screen.getByTestId('enquiry-project-details');
    expect(block).toHaveTextContent('Arm: Full sleeve, Forearm — New tattoo');
    expect(block).toHaveTextContent('Leg: Back of the knee — Cover-up, Rework');
    expect(block).toHaveTextContent('Black & Grey realism, Colour realism');
    expect(block).toHaveTextContent('Whole left arm');
    expect(block).toHaveTextContent('Old tribal on the calf');
  });

  it('translates catalogue labels for a Russian reader but keeps client text', () => {
    render(<EnquiryProjectDetails details={DETAILS} language="ru" />);
    const block = screen.getByTestId('enquiry-project-details');
    expect(block).toHaveTextContent('Рука: Полный рукав, Предплечье — Новая татуировка');
    expect(block).toHaveTextContent('Back of the knee');
    expect(block).toHaveTextContent('Old tribal on the calf');
  });

  it('shows structured details and labels existing tattoo photos on the enquiry page', async () => {
    enquiry.project_details = DETAILS;
    file.intake_role = 'existing_tattoo';
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });
    expect(await screen.findByTestId('enquiry-project-details')).toHaveTextContent('Arm: Full sleeve, Forearm');
    const group = await screen.findByTestId('enquiry-images-existing');
    expect(within(group).getByText('Existing tattoo photos (1)')).toBeInTheDocument();
  });

  it('shows localized coverage and a historical estimate without treating it as agreed price', () => {
    const original: Details = {...DETAILS, calculator_estimate_superseded:true, calculator_selection:[{region:'arm',placements:['full_sleeve'],side:'right',coverage:'wrap'}],calculator_estimate:{schema:'tattoo-estimate-v1',rules_version:'2026-11-25.1',non_binding:true,currency:'GBP',project:{styles:['colour'],areas:[{region:'arm',placements:['full_sleeve'],work:['new'],side:'left'}]},result:{numeric:true,price:'£7,840–£9,800',time:'56–70 hours',visits:'8–10 sessions',hours:[56,70],sessions:[8,10],cost_gbp:[7840,9800],open:false,provisional:true,cover_up:true}}};
    render(<EnquiryProjectDetails details={original} language="ru" />);
    const block=screen.getByTestId('tattoo-selection');
    expect(block).toHaveTextContent('Правая');
    expect(block).toHaveTextContent('По кругу');
    expect(block).toHaveTextContent('56–70 ч');
    expect(block).toHaveTextContent('Исходная оценка · требует пересмотра');
    expect(block).not.toHaveTextContent('Левая');
  });

  it('keeps the legacy summary and unlabelled images for older enquiries', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/enquiries/${ENQUIRY_ID}` });
    expect(await screen.findByTestId('enquiry-images-other')).toBeInTheDocument();
    expect(screen.queryByTestId('enquiry-project-details')).toBeNull();
    expect(screen.queryByText(/Existing tattoo photos/)).toBeNull();
  });
});
