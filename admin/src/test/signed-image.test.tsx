import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignedImage, isEmbeddedBrowser } from '../components/SignedImage';
import type { EnquiryFile } from '../lib/types';

const { api, signedFileUrl, confirmDialog } = vi.hoisted(() => {
  const signedFileUrl = vi.fn();
  return {
    signedFileUrl,
    confirmDialog: vi.fn(),
    api: { signedFileUrl },
  };
});

vi.mock('../lib/session', () => ({
  useApi: () => api,
}));

vi.mock('../lib/i18n', () => ({
  useLanguage: () => ({
    t: (key: string) => key,
    language: 'en',
  }),
}));

vi.mock('../lib/confirm-dialog', () => ({
  confirmDialog,
  cancelLabelFor: () => 'Go back',
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
    confirmDialog.mockReset();
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

  it('requires the shared confirmation before removing a reference', async () => {
    signedFileUrl.mockResolvedValue('https://storage.example/preview-token');
    confirmDialog.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const onRemove = vi.fn();

    render(<SignedImage file={FILE} onRemove={onRemove} />);

    await screen.findByRole('img');
    const remove = screen.getByRole('button', { name: 'image.remove' });

    fireEvent.click(remove);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(onRemove).not.toHaveBeenCalled();

    fireEvent.click(remove);
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
    expect(confirmDialog).toHaveBeenCalledTimes(2);
  });

  it('shows the original inside the CRM when the popup is blocked', async () => {
    signedFileUrl
      .mockResolvedValueOnce('https://storage.example/preview-token')
      .mockResolvedValueOnce('https://storage.example/fresh-token');
    vi.spyOn(window, 'open').mockReturnValue(null);

    render(<SignedImage file={FILE} />);

    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'image.openOriginal' }));

    const viewer = await screen.findByRole('dialog');
    expect(viewer.querySelector('img')).toHaveAttribute('src', 'https://storage.example/fresh-token');
    expect(screen.queryByText('image.openFailed')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'image.close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never calls window.open inside the Telegram in-app browser', async () => {
    signedFileUrl
      .mockResolvedValueOnce('https://storage.example/preview-token')
      .mockResolvedValueOnce('https://storage.example/fresh-token');
    const open = vi.spyOn(window, 'open');
    (window as unknown as Record<string, unknown>).TelegramWebviewProxy = {};
    try {
      render(<SignedImage file={FILE} />);
      await screen.findByRole('img');
      fireEvent.click(screen.getByRole('button', { name: 'image.openOriginal' }));
      const viewer = await screen.findByRole('dialog');
      expect(viewer.querySelector('img')).toHaveAttribute('src', 'https://storage.example/fresh-token');
      expect(open).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as Record<string, unknown>).TelegramWebviewProxy;
    }
  });
});

describe('isEmbeddedBrowser', () => {
  const plain = {} as Window;
  it('recognises in-app browsers', () => {
    expect(isEmbeddedBrowser(plain, 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36 Telegram-Android/11.2.0')).toBe(true);
    expect(isEmbeddedBrowser({ TelegramWebviewProxy: {} } as unknown as Window, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')).toBe(true);
    expect(isEmbeddedBrowser(plain, 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 Instagram 350.0')).toBe(true);
  });

  it('leaves ordinary browsers on the new-tab path', () => {
    expect(isEmbeddedBrowser(plain, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe(false);
    expect(isEmbeddedBrowser(plain, 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36')).toBe(false);
    expect(isEmbeddedBrowser(plain, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36')).toBe(false);
  });
});
