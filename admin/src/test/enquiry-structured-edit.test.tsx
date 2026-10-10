import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EnquiryEditPanel } from '../components/EnquiryEditPanel';
import { EnquiryStructuredEditPanel } from '../components/EnquiryStructuredEditPanel';
import {
  detailsToInput,
  firstProblem,
  toggleExclusive,
  togglePlacement,
  toPayload,
  V2_REGIONS,
  V2_STYLES,
  V2_WORK,
} from '../lib/enquiry-v2-catalogue';
import type { RecordEditApi } from '../lib/record-edit-api';
import type { Enquiry, EnquiryProjectDetails } from '../lib/types';
import { ENQUIRY } from './fixtures';

// Full sleeve with a forearm cover-up plus a separate colour leg tattoo, as
// the Worker stores it.
const DETAILS: EnquiryProjectDetails = {
  schema: 'enquiry-v2',
  areas: [
    { region: 'Arm', placements: ['Full sleeve', 'Forearm'], work: ['Cover-up'] },
    { region: 'Leg', placements: ['Calf'], work: ['New tattoo'] },
  ],
  styles: ['Colour realism'],
  existingDetails: 'Old tribal band',
  imageRequirements: { designReference: true, existingTattooPhoto: true },
};

const STRUCTURED = {
  ...ENQUIRY,
  project_type: 'Cover-up',
  placement: 'Arm: Full sleeve, Forearm; Leg: Calf',
  cover_up: 'Yes',
  preferred_timing: 'Spring',
  idea: 'Client words',
  project_details: DETAILS,
} as unknown as Enquiry;

describe('booking form v2 catalogue mapping', () => {
  it('maps stored labels back to form keys', () => {
    expect(detailsToInput(DETAILS)).toEqual({
      areas: [
        { region: 'arm', placements: ['full_sleeve', 'forearm'], work: ['cover_up'] },
        { region: 'leg', placements: ['calf'], work: ['new'] },
      ],
      styles: ['colour'],
      existingDetails: 'Old tribal band',
    });
  });

  it('refuses to guess an unknown stored label', () => {
    expect(detailsToInput({ ...DETAILS, areas: [{ region: 'Tail', placements: [], work: ['New tattoo'] }] })).toBeNull();
  });

  it('keeps one sleeve length per area and exclusive choices alone', () => {
    const arm = V2_REGIONS.find((region) => region.key === 'arm')!;
    expect(togglePlacement(arm, ['half_sleeve', 'forearm'], 'full_sleeve')).toEqual(['forearm', 'full_sleeve']);
    expect(toggleExclusive(V2_WORK, ['cover_up', 'extension'], 'new')).toEqual(['new']);
    expect(toggleExclusive(V2_WORK, ['new'], 'cover_up')).toEqual(['cover_up']);
    expect(toggleExclusive(V2_WORK, ['cover_up'], 'rework')).toEqual(['cover_up', 'rework']);
    expect(toggleExclusive(V2_STYLES, ['colour', 'black_grey'], 'not_sure')).toEqual(['not_sure']);
  });

  it('reports what the server would refuse and drops fields the form would not send', () => {
    expect(firstProblem({ areas: [], styles: ['colour'] })).toBe('area');
    expect(firstProblem({ areas: [{ region: 'arm', placements: [], work: ['new'] }], styles: ['colour'] })).toBe('placement');
    expect(firstProblem({ areas: [{ region: 'other', placements: [], work: ['new'] }], styles: ['colour'] })).toBe('other');
    expect(firstProblem({ areas: [{ region: 'arm', placements: ['forearm'], work: [] }], styles: ['colour'] })).toBe('work');
    expect(firstProblem({ areas: [{ region: 'arm', placements: ['forearm'], work: ['new'] }], styles: [] })).toBe('style');
    expect(toPayload({
      areas: [{ region: 'arm', placements: ['forearm'], otherPlacement: 'stale', work: ['new'] }],
      styles: ['colour'],
      sizeNotes: '  ',
      existingDetails: 'not existing work',
    })).toEqual({ areas: [{ region: 'arm', placements: ['forearm'], work: ['new'] }], styles: ['colour'] });
  });
});

function renderStructured(updateEnquiryProjectDetails = vi.fn().mockResolvedValue({ changed_fields: ['project_details'] })) {
  const api = { updateEnquiryProjectDetails } as unknown as Pick<RecordEditApi, 'updateEnquiryProjectDetails'>;
  const onSaved = vi.fn();
  render(
    <EnquiryStructuredEditPanel
      enquiry={STRUCTURED}
      details={DETAILS}
      role="owner"
      api={api}
      language="en"
      onSaved={onSaved}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit body areas and style' }));
  return { updateEnquiryProjectDetails, onSaved };
}

describe('structured enquiry editor', () => {
  it('adds Extension next to Cover-up and sends keys plus the loaded state', async () => {
    const { updateEnquiryProjectDetails, onSaved } = renderStructured();
    const extension = screen.getAllByRole('checkbox', { name: 'Extension' })[0];
    fireEvent.click(extension);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateEnquiryProjectDetails).toHaveBeenCalledTimes(1));
    expect(updateEnquiryProjectDetails).toHaveBeenCalledWith(
      STRUCTURED.id,
      {
        areas: [
          { region: 'arm', placements: ['full_sleeve', 'forearm'], work: ['cover_up', 'extension'] },
          { region: 'leg', placements: ['calf'], work: ['new'] },
        ],
        styles: ['colour'],
        existingDetails: 'Old tribal band',
      },
      'Spring',
      { projectDetails: DETAILS, preferredTiming: 'Spring' },
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('adds a new body area and blocks saving until it is complete', () => {
    renderStructured();
    fireEvent.change(screen.getByRole('combobox', { name: 'Add body area' }), { target: { value: 'back' } });
    expect(screen.getByText('Choose a placement for every area.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows the conflict message from the server and keeps the form open', async () => {
    const conflict = vi.fn().mockRejectedValue(new Error('Someone else changed this enquiry since you opened it. Reload the page and make your change again.'));
    renderStructured(conflict);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this enquiry');
    expect(screen.getByTestId('enquiry-structured-edit')).toBeInTheDocument();
  });

  it('is not offered to read-only users', () => {
    render(
      <EnquiryStructuredEditPanel
        enquiry={STRUCTURED}
        details={DETAILS}
        role="read_only"
        api={{ updateEnquiryProjectDetails: vi.fn() } as unknown as Pick<RecordEditApi, 'updateEnquiryProjectDetails'>}
        language="en"
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit body areas and style' })).not.toBeInTheDocument();
  });
});

describe('description-only edit on a structured enquiry', () => {
  it('sends only the description, never the derived columns', async () => {
    const updateEnquiryIdea = vi.fn().mockResolvedValue({});
    const updateEnquiryDetails = vi.fn();
    render(
      <EnquiryEditPanel
        enquiry={STRUCTURED}
        role="owner"
        api={{ updateEnquiryIdea, updateEnquiryDetails } as unknown as Pick<RecordEditApi, 'updateEnquiryDetails' | 'updateEnquiryIdea'>}
        language="en"
        onSaved={vi.fn()}
        mode="idea"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    expect(screen.queryByText('Placement')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Operator note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateEnquiryIdea).toHaveBeenCalledWith(STRUCTURED.id, 'Operator note'));
    expect(updateEnquiryDetails).not.toHaveBeenCalled();
  });
});
