import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { bookingErrorCode, bookingErrorMessage } from '../lib/booking-errors';
import { CLIENT_ID, ENQUIRY_ID, renderWithSession } from './fixtures';

describe('booking controls on a phone', () => {
  it('keeps the selected session duration in the pressed state', async () => {
    renderWithSession(<App />, { role: 'owner', path: `/clients/${CLIENT_ID}` });

    const sevenHours = await screen.findByRole('button', { name: '7 h' });
    const threeHours = screen.getByRole('button', { name: '3 h' });

    expect(sevenHours).toHaveAttribute('aria-pressed', 'true');
    expect(threeHours).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(threeHours);

    expect(threeHours).toHaveAttribute('aria-pressed', 'true');
    expect(sevenHours).toHaveAttribute('aria-pressed', 'false');
  });

  it('uses the same deterministic five-minute picker for consultations', async () => {
    renderWithSession(<App />, {
      role: 'owner',
      path: `/enquiries/${ENQUIRY_ID}`,
    });

    await screen.findByRole('group', { name: 'Date and time' });

    const minute = screen.getByLabelText('Minute') as HTMLSelectElement;
    expect(Array.from(minute.options).map((option) => option.value)).toEqual([
      '00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55',
    ]);
    expect(Array.from(minute.options).some((option) => option.value === '03')).toBe(false);
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  });

  it('uses the policy-aware conflict read and books a valid consultation', async () => {
    const rpcCalls: { name: string; args: Record<string, unknown> | undefined }[] = [];
    renderWithSession(<App />, {
      role: 'owner',
      path: `/enquiries/${ENQUIRY_ID}`,
      rpcCalls,
    });

    await screen.findByRole('group', { name: 'Date and time' });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2030-01-08' } });
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule consultation' }));

    await waitFor(() => {
      expect(rpcCalls.find((entry) => entry.name === 'list_booking_conflicts')).toBeDefined();
      const booking = rpcCalls.find((entry) => entry.name === 'schedule_appointment');
      expect(booking?.args?.p_appointment_type).toBe('in_person_consultation');
      expect(booking?.args?.p_project_id).toBeNull();
      expect(booking?.args?.p_enquiry_id).toBe(ENQUIRY_ID);
    });
  });

  it('turns an off-grid database refusal into a specific message', () => {
    const raw = {
      code: '22023',
      message: 'appointment times must use five-minute increments',
      hint: 'INVALID_APPOINTMENT_STEP',
    };

    const code = bookingErrorCode(raw);
    expect(code).toBe('INVALID_APPOINTMENT_STEP');
    expect(bookingErrorMessage(code!, 'ru')).toMatch(/шагом 5 минут/);
  });
});
