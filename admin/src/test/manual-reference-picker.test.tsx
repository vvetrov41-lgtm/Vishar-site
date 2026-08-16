import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualReferencePicker } from '../components/ManualReferencePicker';

function Harness() {
  const [files, setFiles] = useState<File[]>([]);
  return <ManualReferencePicker files={files} onChange={setFiles} language="en" />;
}

describe('manual reference picker', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:synthetic-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects and previews a reference before the enquiry is saved', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Reference images');
    const file = new File(['synthetic'], 'reference.jpg', { type: 'image/jpeg' });

    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByAltText('reference.jpg')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('rejects unsupported formats and more than three references', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Reference images');
    const invalid = new File(['synthetic'], 'reference.gif', { type: 'image/gif' });

    fireEvent.change(input, { target: { files: [invalid] } });
    expect(screen.getByRole('alert')).toHaveTextContent('Only JPG, PNG or WebP');

    const files = [1, 2, 3, 4].map((index) => new File(['synthetic'], `reference-${index}.jpg`, { type: 'image/jpeg' }));
    fireEvent.change(input, { target: { files } });
    expect(screen.getByRole('alert')).toHaveTextContent('up to 3');
  });
});
