import { describe, expect, it } from 'vitest';
import {
  APPOINTMENT_TIME_STEP_SECONDS,
  applyAppointmentTimeStep,
} from '../lib/appointment-time-step';

describe('appointment time step', () => {
  it('sets every datetime-local input to a five-minute step', () => {
    document.body.innerHTML = `
      <input type="datetime-local" id="start">
      <input type="datetime-local" id="end" step="60">
      <input type="text" id="notes">
    `;

    applyAppointmentTimeStep();

    expect(APPOINTMENT_TIME_STEP_SECONDS).toBe(300);
    expect((document.querySelector('#start') as HTMLInputElement).step).toBe('300');
    expect((document.querySelector('#end') as HTMLInputElement).step).toBe('300');
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
});
