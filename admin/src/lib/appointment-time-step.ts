export const APPOINTMENT_TIME_STEP_SECONDS = 300;

export function applyAppointmentTimeStep(root: ParentNode = document): void {
  root.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]').forEach((input) => {
    input.step = String(APPOINTMENT_TIME_STEP_SECONDS);
  });
}
