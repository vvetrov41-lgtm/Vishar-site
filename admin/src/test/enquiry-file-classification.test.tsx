import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { describeFileClassification, EnquiryFileClassification } from '../components/EnquiryFileClassification';
import type { RecordEditApi } from '../lib/record-edit-api';
import type { EnquiryFile } from '../lib/types';
import { ENQUIRY_FILE } from './fixtures';

const FILE = { ...ENQUIRY_FILE, id: 'file-1', intake_role: null, body_areas: [] } as EnquiryFile;

describe('enquiry image classification', () => {
  it('describes category and areas in both languages', () => {
    expect(describeFileClassification({ intake_role: 'existing_tattoo', body_areas: ['arm'] }, 'en')).toBe('Existing tattoo / Arm');
    expect(describeFileClassification({ intake_role: 'design_reference', body_areas: ['leg', 'arm'] }, 'ru')).toBe('Референс дизайна / Нога, Рука');
    expect(describeFileClassification({ intake_role: null, body_areas: [] }, 'en')).toBe('');
  });

  it('lets staff set a category and several areas, offering the enquiry areas first', async () => {
    const setEnquiryFileClassification = vi.fn().mockResolvedValue({});
    const onSaved = vi.fn();
    render(
      <EnquiryFileClassification
        file={FILE}
        role="booking_manager"
        api={{ setEnquiryFileClassification } as unknown as Pick<RecordEditApi, 'setEnquiryFileClassification'>}
        language="en"
        suggestedAreas={['leg']}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Classify' }));
    expect(screen.getAllByRole('checkbox')[0]).toHaveAccessibleName('Leg');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'design_reference' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Leg' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Arm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setEnquiryFileClassification).toHaveBeenCalledWith('file-1', 'design_reference', ['leg', 'arm']));
    expect(onSaved).toHaveBeenCalled();
  });

  it('is read-only for users who cannot manage files', () => {
    render(
      <EnquiryFileClassification
        file={{ ...FILE, intake_role: 'existing_tattoo', body_areas: ['arm'] }}
        role="read_only"
        api={{ setEnquiryFileClassification: vi.fn() } as unknown as Pick<RecordEditApi, 'setEnquiryFileClassification'>}
        language="en"
        suggestedAreas={[]}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText('Existing tattoo / Arm')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Classify' })).not.toBeInTheDocument();
  });
});
