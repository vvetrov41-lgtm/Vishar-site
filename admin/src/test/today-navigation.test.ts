import { describe, expect, it } from 'vitest';
import { enquiryTargetsForToday } from '../lib/today-navigation';
import { pulseToTodayItems, type TodayPulse } from '../lib/today-pulse';
import type { TodayItem } from '../lib/today-workspace';
import type { Enquiry } from '../lib/types';
import { CLIENT_ID, ENQUIRY, ENQUIRY_ID, VLADIMIR_ARTIST_ID, KRISTINA_ARTIST_ID } from './fixtures';

const reply: TodayItem = {
  key: `gmail-${CLIENT_ID}`, kind: 'reply', artistId: VLADIMIR_ARTIST_ID, clientId: CLIENT_ID,
  href: `/inbox/email/client-${CLIENT_ID}`, subject: 'Client', at: null, detail: null,
  urgent: true, acknowledgement: null,
};
const resolve = (items: TodayItem[], enquiries: Enquiry[] = [ENQUIRY]) => enquiryTargetsForToday(items, enquiries, [], []);

describe('Today enquiry navigation', () => {
  it('opens the single active enquiry for a client-only Gmail reply', () => {
    expect(resolve([reply])[0].href).toBe(`/enquiries/${ENQUIRY_ID}`);
  });
  it('keeps server pulse artist and client context for the same navigation', () => {
    const pulse = { items: [{ ...reply, artist_id: VLADIMIR_ARTIST_ID, client_id: CLIENT_ID,
      acknowledgement: null }] } as unknown as TodayPulse;
    expect(resolve(pulseToTodayItems(pulse))[0].href).toBe(`/enquiries/${ENQUIRY_ID}`);
  });
  it('opens the client when multiple active enquiries leave the target ambiguous', () => {
    expect(resolve([reply], [ENQUIRY, { ...ENQUIRY, id: 'other' }])[0].href).toBe(`/clients/${CLIENT_ID}`);
  });
  it('honours an explicit linked enquiry even when the client has several', () => {
    expect(resolve([{ ...reply, enquiryId: ENQUIRY_ID }], [ENQUIRY, { ...ENQUIRY, id: 'other' }])[0].href)
      .toBe(`/enquiries/${ENQUIRY_ID}`);
  });
  it('does not select another artist, an archived enquiry or a closed enquiry', () => {
    for (const enquiry of [
      { ...ENQUIRY, artist_id: KRISTINA_ARTIST_ID },
      { ...ENQUIRY, archived_at: '2026-10-01T00:00:00Z' },
      { ...ENQUIRY, status: 'closed' as const },
    ]) expect(resolve([reply], [enquiry])[0].href).toBe(`/clients/${CLIENT_ID}`);
  });
  it('preserves system and appointment destinations', () => {
    const item = { ...reply, kind: 'reschedule_requested' as const, href: '/appointments/a' };
    expect(resolve([item])[0]).toBe(item);
  });
});
