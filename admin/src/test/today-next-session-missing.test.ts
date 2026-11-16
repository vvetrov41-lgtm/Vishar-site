import { describe, expect, it } from 'vitest';
import { translate } from '../lib/i18n';
import { enquiryTargetsForToday } from '../lib/today-navigation';
import { pulseToTodayItems, type PulseItem, type TodayPulse } from '../lib/today-pulse';
import { CLIENT_ID, ENQUIRY, VLADIMIR_ARTIST_ID } from './fixtures';

const PROJECT_ID = 'e3941000-0000-4000-8000-0000000000c1';

const item: PulseItem = {
  key: `next-session-${PROJECT_ID}`,
  kind: 'next_session_missing',
  section: 'waiting_for_you',
  reason: 'next_session_not_booked',
  artist_id: VLADIMIR_ARTIST_ID,
  client_id: CLIENT_ID,
  subject: 'Client',
  href: `/projects/${PROJECT_ID}`,
  at: '2026-11-06T10:00:00Z',
  detail: 'Sleeve',
  sla_state: null,
  ai_suggestion: null,
  acknowledgement: null,
  urgent: false,
};

describe('Today: project with no next session booked', () => {
  it('keeps the server row and opens the project, not the enquiry', () => {
    const pulse = { generated_at: '', enabled: true, items: [item], artists: [] } as TodayPulse;
    const rows = enquiryTargetsForToday(pulseToTodayItems(pulse), [ENQUIRY], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'next_session_missing', href: `/projects/${PROJECT_ID}`, detail: 'Sleeve' });
  });

  it('has a label in both languages', () => {
    expect(translate('en', 'today.item.next_session_missing')).toBe('No next session booked');
    expect(translate('ru', 'today.item.next_session_missing')).toBe('Следующий сеанс не назначен');
  });
});
