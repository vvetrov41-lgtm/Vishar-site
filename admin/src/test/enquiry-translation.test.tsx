import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EnquiryTranslation } from '../components/EnquiryTranslation';

const ENQUIRY = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';

function fakeApi(final: Record<string, unknown>) {
  return {
    requestEnquiryTranslation: vi.fn(async () => ({ status: 'pending' as const, job_id: JOB })),
    runEnquiryTranslation: vi.fn(async () => undefined),
    getEnquiryTranslation: vi.fn(async () => final as never),
  };
}

describe('manual enquiry translation', () => {
  it('does nothing until the artist presses the button', () => {
    const api = fakeApi({ status: 'succeeded', translation: 'Перевод' });
    render(<EnquiryTranslation enquiryId={ENQUIRY} api={api} language="ru" />);
    expect(screen.getByRole('button', { name: 'Перевести на русский' })).toBeInTheDocument();
    expect(api.requestEnquiryTranslation).not.toHaveBeenCalled();
    expect(api.runEnquiryTranslation).not.toHaveBeenCalled();
    expect(api.getEnquiryTranslation).not.toHaveBeenCalled();
  });

  it('runs the job, reads the text back and labels it as a machine translation', async () => {
    const api = fakeApi({ status: 'succeeded', translation: 'Полрукава на левом предплечье, около 15 см.' });
    render(<EnquiryTranslation enquiryId={ENQUIRY} api={api} language="ru" />);
    fireEvent.click(screen.getByRole('button', { name: 'Перевести на русский' }));
    expect(await screen.findByText('Полрукава на левом предплечье, около 15 см.')).toBeInTheDocument();
    expect(screen.getByText(/Машинный перевод/)).toBeInTheDocument();
    expect(api.runEnquiryTranslation).toHaveBeenCalledWith(JOB);
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть перевод' }));
    expect(screen.queryByText('Полрукава на левом предплечье, около 15 см.')).not.toBeInTheDocument();
  });

  it('uses a cached translation without running a job', async () => {
    const api = fakeApi({ status: 'succeeded', translation: 'x' });
    api.requestEnquiryTranslation.mockResolvedValueOnce({ status: 'succeeded', job_id: JOB, translation: 'Кеш' } as never);
    render(<EnquiryTranslation enquiryId={ENQUIRY} api={api} language="ru" />);
    fireEvent.click(screen.getByRole('button', { name: 'Перевести на русский' }));
    expect(await screen.findByText('Кеш')).toBeInTheDocument();
    expect(api.runEnquiryTranslation).not.toHaveBeenCalled();
  });

  it('a failed translation says the original stays the source of truth', async () => {
    const api = fakeApi({ status: 'failed', error_code: 'output_invalid' });
    render(<EnquiryTranslation enquiryId={ENQUIRY} api={api} language="ru" />);
    fireEvent.click(screen.getByRole('button', { name: 'Перевести на русский' }));
    expect(await screen.findByText(/Оригинал выше остаётся основным текстом/)).toBeInTheDocument();
  });

  describe('when a request is never answered (in-app browsers)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('a run request that never returns still reads the finished translation', async () => {
      vi.useFakeTimers();
      const api = fakeApi({ status: 'succeeded', translation: 'Готово' });
      api.runEnquiryTranslation.mockReturnValue(new Promise<undefined>(() => {}));
      render(<EnquiryTranslation enquiryId={ENQUIRY} api={api} language="ru" />);
      fireEvent.click(screen.getByRole('button', { name: 'Перевести на русский' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(26000); });
      expect(screen.getByText('Готово')).toBeInTheDocument();
    });

    it('releases the button when the first request never returns', async () => {
      vi.useFakeTimers();
      const api = fakeApi({ status: 'succeeded', translation: 'x' });
      api.requestEnquiryTranslation.mockReturnValue(new Promise(() => {}) as never);
      render(<EnquiryTranslation enquiryId={ENQUIRY} api={api} language="ru" />);
      fireEvent.click(screen.getByRole('button', { name: 'Перевести на русский' }));
      expect(screen.getByRole('button', { name: 'Перевожу…' })).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
      expect(screen.getByText('Перевод сейчас недоступен.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Перевести на русский' })).toBeEnabled();
    });

    it('stops polling within the overall limit when reads never return', async () => {
      vi.useFakeTimers();
      const api = fakeApi({ status: 'succeeded', translation: 'x' });
      api.getEnquiryTranslation.mockReturnValue(new Promise(() => {}) as never);
      render(<EnquiryTranslation enquiryId={ENQUIRY} api={api} language="ru" />);
      fireEvent.click(screen.getByRole('button', { name: 'Перевести на русский' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(46000); });
      expect(screen.getByText(/Перевод ещё готовится/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Перевести на русский' })).toBeEnabled();
    });
  });
});
