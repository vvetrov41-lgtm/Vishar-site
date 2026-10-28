import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MonthCalendarView } from '../components/MonthCalendarView';
import { buildMonthCalendar } from '../lib/calendar-month';
import type { Appointment } from '../lib/appointment-api';

const base = { id:'appointment-1', artist_id:'artist-1', client_id:'client-1', project_id:'project-1', enquiry_id:null, appointment_type:'tattoo_session', status:'confirmed', start_at:'2099-09-01T10:00:00Z', end_at:'2099-09-01T16:00:00Z', duration_hours:6, currency:'GBP', payment_status:'unpaid', calendar_provider:'none', calendar_event_id:null, calendar_version:3, calendar_sync_status:'not_connected', calendar_last_synced_version:null, calendar_last_synced_at:null, calendar_last_error_code:null, client_response:null, client_response_at:null, client_response_calendar_version:null, notes:null, cancelled_at:null } satisfies Appointment;

function renderMonth(appointments: Appointment[]) {
  const month = buildMonthCalendar({ month:new Date(2099,8,1), now:new Date(2099,7,1,12), appointments, timeOff:[] });
  return render(<MonthCalendarView month={month} visibleMonth={month.days[10].date} selectedDay={month.days[10].date} language="ru" clients={[]} onSelectDay={() => {}} onPreviousMonth={() => {}} onNextMonth={() => {}} onToday={() => {}} />);
}

describe('month calendar chips', () => {
  it('keeps confirmation wording out of the cell and shows it as an indicator with a tooltip', () => {
    const { container } = renderMonth([
      base,
      { ...base, id:'appointment-2', start_at:'2099-09-02T10:00:00Z', end_at:'2099-09-02T16:00:00Z', client_response:'attendance_confirmed', client_response_calendar_version:3 },
    ]);
    expect(container.textContent).not.toContain('Ожидаем подтверждения клиента');
    expect(container.textContent).not.toContain('Клиент подтвердил');
    const indicators = [...container.querySelectorAll('.calendar-event-attendance')].map((node) => node.getAttribute('data-attendance'));
    expect(indicators).toEqual(['awaiting_client', 'client_confirmed']);
    const titles = [...container.querySelectorAll('.calendar-event')].map((node) => node.getAttribute('title'));
    expect(titles).toEqual(['Ожидаем подтверждения клиента', 'Клиент подтвердил']);
  });

  it('shows no attendance indicator for bookings that are not confirmed', () => {
    const { container } = renderMonth([{ ...base, status:'cancelled', cancelled_at:'2099-08-20T10:00:00Z' }]);
    expect(container.querySelector('.calendar-event-attendance')).toBeNull();
    expect(container.querySelector('.calendar-event')?.getAttribute('title')).toBeNull();
  });
});
