import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignedImage } from '../components/SignedImage';
import type { EnquiryFile } from '../lib/types';

const { api, signedFileUrl } = vi.hoisted(() => {
  const signedFileUrl = vi.fn();
  return {
    signedFileUrl,
    api: { signedFileUrl },
  };
});

vi.mock('../lib/session', () => ({
  useApi: () => api,
}));

vi.mock('../lib/i18n', () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}));

const FILE: EnquiryFile = {
  id: 'file-1',
  enquiry_id: 'enquiry-1',
  ordinal: 1,
  storage_path: 'enquiries/enquiry-1/reference.jpg',
  original_filename: 'reference.jpg',
  mime_type: 'image/jpeg',
  byte_size: 12345,
  upload_state: 'ready',
  created_at: '2026-08-26T12:00:00Z',
};

describe('SignedImage', () => {
  beforeEach(() => {
    signedFileUrl.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints a fresh signed URL on every deliberate open instead of reusing the preview URL', async () => {
    signedFileUrl
      .mockResolvedValueOnce('https://storage.example/preview-token')
      .mockResolvedValueOnce('https://storage.example/fresh-token');

    const replace = vi.fn();
    const opened = {
      opener: window,
      location: { replace },
      close: vi.fn(),
    } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(opened);

    render(<SignedImage file={FILE} />);

    const image = await screen.findByRole('img');
    expect(image).toHaveAttribute('src', 'https://storage.example/preview-token');
    expect(signedFileUrl).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'image.openOriginal' }));

    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(opened.opener).toBeNull();
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('https://storage.example/fresh-token');
    });
    expect(signedFileUrl).toHaveBeenCalledTimes(2);
    expect(signedFileUrl).toHaveBeenNthCalledWith(2, FILE.storage_path);
    expect(image).toHaveAttribute('src', 'https://storage.example/fresh-token');
  });

  it('closes the blank tab and reports an error when a fresh URL cannot be minted', async () => {
    signedFileUrl
      .mockResolvedValueOnce('https://storage.example/preview-token')
      .mockResolvedValueOnce(null);

    const close = vi.fn();
    const opened = {
      opener: window,
      location: { replace: vi.fn() },
      close,
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(opened);

    render(<SignedImage file={FILE} />);

    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'image.openOriginal' }));

    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('image.openFailed')).toBeInTheDocument();
  });
});
