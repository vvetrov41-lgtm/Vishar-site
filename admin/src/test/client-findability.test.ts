// Finding a client by how they actually contacted you.
//
// listClients() matched `full_name` only, so a WhatsApp message from a phone
// number, an email address or an Instagram handle could not be traced back to
// the person — even though all four values are stored on the row and were
// already being selected. Phone numbers additionally arrive from a booking
// form, a WhatsApp profile and manual entry, so the same subscriber can be
// stored as +447700900123, 07700900123 or 447700900123.

import { describe, expect, it } from 'vitest';
import { createApi } from '../lib/api';
import { phoneSearchCandidates } from '../lib/phone';
import { createFakeClient, VLADIMIR_ARTIST_ID } from './fixtures';

function apiWithCalls() {
  const queryCalls: { table: string; method: string; args: unknown[] }[] = [];
  const client = createFakeClient({
    role: 'owner',
    accessibleArtistIds: [VLADIMIR_ARTIST_ID],
    queryCalls,
  });
  return { api: createApi(client), queryCalls };
}

async function clientFilterFor(term: string): Promise<string> {
  const { api, queryCalls } = apiWithCalls();
  await api.listClients(term);
  const call = queryCalls.find((entry) => entry.table === 'clients' && entry.method === 'or');
  expect(call, `no client search issued for ${term}`).toBeDefined();
  return String(call?.args[0]);
}

describe('client search', () => {
  it('searches a full name', async () => {
    const filter = await clientFilterFor('Diana Didy');
    expect(filter).toContain('full_name.ilike.*Diana Didy*');
  });

  it('searches a partial name', async () => {
    const filter = await clientFilterFor('Dia');
    expect(filter).toContain('full_name.ilike.*Dia*');
  });

  it('searches an email address', async () => {
    const filter = await clientFilterFor('diana@example.test');
    expect(filter).toContain('email.ilike.*diana@example.test*');
  });

  it('searches an Instagram handle', async () => {
    const filter = await clientFilterFor('@diana.d');
    expect(filter).toContain('instagram.ilike.*@diana.d*');
  });

  it('searches a phone number in the form it was typed and the forms it may be stored as', async () => {
    const filter = await clientFilterFor('07700 900123');
    // As typed, digits only, international, and back to the local form.
    expect(filter).toContain('phone.ilike.*07700 900123*');
    expect(filter).toContain('phone.ilike.*07700900123*');
    expect(filter).toContain('phone.ilike.*447700900123*');
    expect(filter).toContain('phone.ilike.*7700900123*');
  });

  it('finds the same subscriber typed in international form', async () => {
    const filter = await clientFilterFor('+44 7700 900123');
    expect(filter).toContain('phone.ilike.*447700900123*');
    expect(filter).toContain('phone.ilike.*07700900123*');
  });

  it('never lets a search term rewrite the PostgREST filter grammar', async () => {
    const filter = await clientFilterFor('Smith, Jones (ltd)');
    expect(filter).toContain('full_name.ilike.*Smith Jones ltd*');
    // One condition per field plus nothing injected by the term itself.
    expect(filter.split(',').filter((part) => part.includes('.ilike.'))).toHaveLength(4);
  });

  it('leaves an empty search unfiltered rather than matching everything oddly', async () => {
    const { api, queryCalls } = apiWithCalls();
    await api.listClients('   ');
    expect(queryCalls.filter((entry) => entry.table === 'clients' && entry.method === 'or')).toHaveLength(0);
  });
});

describe('enquiry search', () => {
  it('matches the reference or the client behind it', async () => {
    const { api, queryCalls } = apiWithCalls();
    await api.listEnquiries({ search: 'Fixture' });

    const call = queryCalls.find((entry) => entry.table === 'enquiries' && entry.method === 'or');
    expect(call).toBeDefined();
    const filter = String(call?.args[0]);
    expect(filter).toContain('reference_number.ilike.*Fixture*');
    // The fake client returns the fixture client for any lookup, so the
    // resolved id must be carried into the enquiry filter.
    expect(filter).toContain('client_id.in.(');
  });
});

describe('phoneSearchCandidates', () => {
  it('ignores terms too short to be a phone number', () => {
    expect(phoneSearchCandidates('12')).toEqual([]);
    expect(phoneSearchCandidates('')).toEqual([]);
  });

  it('does not invent a country code for an unrecognised number', () => {
    expect(phoneSearchCandidates('5551234')).toEqual(['5551234']);
  });
});
