import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EnquiryReferenceActions } from '../components/EnquiryReferenceActions';
import type { RecordEditApi } from '../lib/record-edit-api';
import type { EnquiryFile } from '../lib/types';
import { ENQUIRY_FILE, ENQUIRY_ID } from './fixtures';

const filesOf = (count: number): EnquiryFile[] =>
  Array.from({ length: count }, (_, i) => ({
    ...ENQUIRY_FILE,
    id: `file-${i + 1}`,
    ordinal: i,
    original_filename: `reference-${i + 1}.jpg`,
  }));

function setup(count: number, role: 'owner' | 'read_only' = 'owner', language: 'en' | 'ru' = 'en') {
  const addEnquiryReference = vi.fn().mockResolvedValue({});
  const finalizeEnquiryReference = vi.fn().mockResolvedValue({});
  const api = { addEnquiryReference, finalizeEnquiryReference } as unknown as
    Pick<RecordEditApi, 'addEnquiryReference' | 'finalizeEnquiryReference'>;
  const onChanged = vi.fn();
  render(
    <EnquiryReferenceActions
      enquiryId={ENQUIRY_ID}
      files={filesOf(count)}
      role={role}
      api={api}
      language={language}
      onChanged={onChanged}
    />,
  );
  return { addEnquiryReference, onChanged };
}

describe('operator enquiry reference slots', () => {
  it('can add the sixth image when five slots are occupied', async () => {
    const { addEnquiryReference, onChanged } = setup(5);
    expect(screen.getByText('Up to 6 images, JPG/PNG/WebP, maximum 4 MB each.')).toBeInTheDocument();
    const input = document.querySelector<HTMLInputElement>('#enquiry-reference-upload');
    expect(input).not.toBeNull();
    const file = new File(['test-image'], 'sixth.jpg', { type: 'image/jpeg' });
    fireEvent.change(input!, { target: { files: [file] } });
    await waitFor(() => expect(addEnquiryReference).toHaveBeenCalledTimes(1));
    expect(addEnquiryReference).toHaveBeenCalledWith(ENQUIRY_ID, file);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('hides the upload action once six slots are occupied', () => {
    setup(6);
    expect(screen.queryByRole('button', { name: 'Add references' })).not.toBeInTheDocument();
    expect(document.querySelector('#enquiry-reference-upload')).toBeNull();
  });

  it('retains existing permissions and Russian limits', () => {
    const rendered = setup(5, 'read_only');
    expect(screen.queryByRole('button', { name: 'Add references' })).not.toBeInTheDocument();
    rendered.onChanged.mockClear();
  });

  it('shows the six-image limit in Russian', () => {
    setup(5, 'owner', 'ru');
    expect(screen.getByText('До 6 изображений, JPG/PNG/WebP, максимум 4 MB каждое.')).toBeInTheDocument();
  });
});
