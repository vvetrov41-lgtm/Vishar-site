import { describe, expect, it } from 'vitest';
import { contactDifferences } from '../components/EnquiryContactConflict';
import { samePhone } from '../lib/phone';
import type { Client, Enquiry } from '../lib/types';

const plain = (value: string | null | undefined) => (value ?? '').trim() || '—';

function pair(clientFields: Partial<Client>, enquiryFields: Partial<Enquiry>) {
  const client = { id: 'client-1', full_name: 'Test Client', ...clientFields } as Client;
  const enquiry = { id: 'enquiry-1', ...enquiryFields } as Enquiry;
  return contactDifferences(enquiry, client, plain).map((field) => field.key);
}

describe('samePhone', () => {
  it('treats a UK mobile in local form as its +44 canonical form', () => {
    expect(samePhone('+447700900123', '07700900123')).toBe(true);
    expect(samePhone('07700 900 123', '+44 7700 900123')).toBe(true);
    expect(samePhone('00447700900123', '+447700900123')).toBe(true);
  });

  it('ignores invisible format characters pasted from a contact card', () => {
    expect(samePhone('+447700900123', '‪07700 900123‬')).toBe(true);
  });

  it('matches a local trunk-0 number against the same national number with a country code', () => {
    expect(samePhone('+442079460000', '020 7946 0000')).toBe(true);
    expect(samePhone('+61293744000', '02 9374 4000')).toBe(true);
    expect(samePhone('+61293744000', '02 9374 4001')).toBe(false);
    expect(samePhone('+442079460000', '0207946')).toBe(false);
  });

  it('keeps a genuinely different number different', () => {
    expect(samePhone('+447700900123', '07700900124')).toBe(false);
    expect(samePhone('+447700900123', '+33612345678')).toBe(false);
    expect(samePhone('0612345678', '0612345679')).toBe(false);
  });

  it('compares unnormalisable values by their digits', () => {
    expect(samePhone('06 12 34 56 78', '0612345678')).toBe(true);
  });
});

describe('contactDifferences', () => {
  it('shows no phone conflict for 07... against the stored +44 number', () => {
    expect(pair({ phone: '+447700900123' }, { submitted_phone: '07700900123' })).toEqual([]);
  });

  it('still shows a phone conflict for a different number', () => {
    expect(pair({ phone: '+447700900123' }, { submitted_phone: '07700900999' })).toEqual(['phone']);
  });

  it('keeps real name and email differences', () => {
    expect(pair(
      { phone: '+447700900123', email: 'a@example.test' },
      { submitted_phone: '07700900123', submitted_full_name: 'Other Name', submitted_email: 'b@example.test' },
    )).toEqual(['fullName', 'email']);
  });
});
