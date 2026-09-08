import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { CLIENT_ID, renderWithSession } from './fixtures';

function dayValue(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

describe('custom manual booking end time', () => {
  it('keeps the automatic end by default and lets the operator override it in five-minute steps', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}` });

    fireEvent.click(await screen.findByRole('button', { name: '7 h' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter a time myself' }));

    const date = dayValue(1);
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } });
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '09' } });
    fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '00' } });

    const automaticEnd = screen.getByLabelText('End') as HTMLInputElement;
    await waitFor(() => expect(automaticEnd.value).toMatch(/16:00/));
    expect(automaticEnd).toHaveAttribute('readonly');

    fireEvent.click(screen.getByRole('button', { name: 'Set custom end' }));

    const endMinute = screen.getByLabelText('End minute') as HTMLSelectElement;
    expect([...endMinute.options].map((option) => option.value)).toEqual([
      '00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55',
    ]);

    fireEvent.change(screen.getByLabelText('End date'), { target: { value: date } });
    fireEvent.change(screen.getByLabelText('End hour'), { target: { value: '16' } });
    fireEvent.change(endMinute, { target: { value: '30' } });

    expect(await screen.findByText('7 h 30 min')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book this exact time' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Calculate end from duration' }));
    const derivedAgain = screen.getByLabelText('End') as HTMLInputElement;
    await waitFor(() => expect(derivedAgain.value).toMatch(/16:30/));
    expect(derivedAgain).toHaveAttribute('readonly');
  });
});
