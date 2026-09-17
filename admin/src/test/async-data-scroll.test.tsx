import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAsync } from '../components/AsyncData';

function ReloadHarness({ loader }: { loader: () => Promise<number> }) {
  const { data, reload } = useAsync(loader, []);
  return (
    <>
      <button type="button" onClick={reload}>Reload record</button>
      <output>{data ?? 'loading'}</output>
    </>
  );
}

describe('useAsync in-place reload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('releases focus and restores the viewport after a record reload', async () => {
    let value = 0;
    const loader = vi.fn(async () => {
      value += 1;
      return value;
    });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 640 });

    render(<ReloadHarness loader={loader} />);
    expect(await screen.findByText('1')).toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Reload record' });
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);

    expect(document.activeElement).not.toBe(button);
    expect(await screen.findByText('2')).toBeInTheDocument();
    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 640, left: 0, behavior: 'auto' });
    });
  });
});
