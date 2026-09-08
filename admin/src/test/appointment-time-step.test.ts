import { describe, expect, it } from 'vitest';
import {
  APPOINTMENT_TIME_STEP_SECONDS,
  appointmentEndValue,
  appointmentTimeRange,
  applyAppointmentTimeStep,
  snapAppointmentStart,
} from '../lib/appointment-time-step';

describe('appointment time step', () => {
  it('sets strict datetime-local inputs to five minutes but preserves explicit unrestricted inputs', () => {
    document.body.innerHTML = `
      <input type="datetime-local" id="start">
      <input type="datetime-local" id="end" step="60">
      <input type="datetime-local" id="consultation" data-appointment-time-step="unrestricted">
      <input type="text" id="notes">
    `;

    applyAppointmentTimeStep();

    expect(APPOINTMENT_TIME_STEP_SECONDS).toBe(300);
    expect((document.querySelector('#start') as HTMLInputElement).step).toBe('300');
    expect((document.querySelector('#end') as HTMLInputElement).step).toBe('300');
    expect((document.querySelector('#consultation') as HTMLInputElement).getAttribute('step')).toBeNull();
    expect((document.querySelector('#notes') as HTMLInputElement).step).toBe('');
  });

  it('can apply the step to a newly mounted subtree without changing inputs outside it', () => {
    document.body.innerHTML = `
      <input type="datetime-local" id="existing" step="60">
      <div id="reschedule">
        <input type="datetime-local" id="next-start">
        <input type="datetime-local" id="next-end" step="60">
      </div>
    `;

    const reschedule = document.querySelector('#reschedule');
    if (!reschedule) throw new Error('reschedule fixture missing');

    applyAppointmentTimeStep(reschedule);
    applyAppointmentTimeStep(reschedule);

    expect((document.querySelector('#existing') as HTMLInputElement).step).toBe('60');
    expect((document.querySelector('#next-start') as HTMLInputElement).step).toBe('300');
    expect((document.querySelector('#next-end') as HTMLInputElement).step).toBe('300');
  });

  it('snaps an automatically suggested manual start forward to five minutes', () => {
    expect(snapAppointmentStart(new Date(2026, 8, 8, 8, 52, 41))).toBe('2026-09-08T08:55');
    expect(snapAppointmentStart(new Date(2026, 8, 8, 8, 55, 41))).toBe('2026-09-08T08:55');
  });

  it('derives manual end from the selected duration', () => {
    expect(appointmentEndValue('2026-09-08T09:00', 420)).toBe('2026-09-08T16:00');
    expect(appointmentEndValue('2026-09-08T09:05', 180)).toBe('2026-09-08T12:05');
  });

  it('builds the submitted range from start plus duration, never an independent end', () => {
    const range = appointmentTimeRange('2026-09-08T09:00', 420);
    expect(range).not.toBeNull();
    if (!range) throw new Error('range missing');

    expect(new Date(range.end).getTime() - new Date(range.start).getTime()).toBe(420 * 60_000);
    expect(appointmentTimeRange('', 420)).toBeNull();
    expect(appointmentTimeRange('2026-09-08T09:00', 0)).toBeNull();
  });
});
