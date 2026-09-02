import { describe, expect, it, vi } from 'vitest';
import type { CrmClient } from '../lib/api';
import {
  DEFAULT_BOOKING_FORMS_ORIGIN,
  bookingSourcePublicUrl,
  createPlatformApi,
} from '../lib/platform-api';
import { readBookingFormsOrigin } from '../lib/supabase';

function clientWithRpc(response: { data: unknown; error: unknown } = { data: [], error: null }) {
  const rpc = vi.fn(async () => response);
  return { client: { rpc } as unknown as CrmClient, rpc };
}

describe('booking source API boundary', () => {
  it('uses the hardened all-manageable list RPC when no Artist is selected', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPlatformApi(client);

    await api.listBookingSources();

    expect(rpc).toHaveBeenCalledWith('list_booking_sources', { p_artist_id: null });
  });

  it('passes an explicit Artist to the same protected list RPC', async () => {
    const { client, rpc } = clientWithRpc();
    const api = createPlatformApi(client);

    await api.listBookingSources('artist-1');

    expect(rpc).toHaveBeenCalledWith('list_booking_sources', { p_artist_id: 'artist-1' });
  });

  it('creates hosted sources disabled and never supplies an external Origin', async () => {
    const { client, rpc } = clientWithRpc({ data: 'source-row-1', error: null });
    const api = createPlatformApi(client);

    await api.createBookingSource({
      artistId: 'artist-1',
      sourceKind: 'hosted',
      displayLabel: 'London enquiries',
      allowedOrigin: 'https://ignored.example.test',
    });

    expect(rpc).toHaveBeenCalledWith('create_booking_source', {
      p_artist_id: 'artist-1',
      p_source_kind: 'hosted',
      p_display_label: 'London enquiries',
      p_allowed_origin: null,
      p_form_template: 'tattoo-enquiry',
      p_activate: false,
    });
  });

  it('creates external sources disabled with the exact operator-supplied Origin', async () => {
    const { client, rpc } = clientWithRpc({ data: 'source-row-2', error: null });
    const api = createPlatformApi(client);

    await api.createBookingSource({
      artistId: 'artist-2',
      sourceKind: 'external',
      displayLabel: 'Existing website',
      allowedOrigin: 'https://example.test',
    });

    expect(rpc).toHaveBeenCalledWith('create_booking_source', {
      p_artist_id: 'artist-2',
      p_source_kind: 'external',
      p_display_label: 'Existing website',
      p_allowed_origin: 'https://example.test',
      p_form_template: 'tattoo-enquiry',
      p_activate: false,
    });
  });

  it('updates only the named booking source through the named RPC', async () => {
    const { client, rpc } = clientWithRpc({ data: true, error: null });
    const api = createPlatformApi(client);

    await api.updateBookingSource({
      bookingSourceId: 'source-row-3',
      displayLabel: 'Updated website',
      allowedOrigin: 'https://updated.example.test',
      isActive: true,
    });

    expect(rpc).toHaveBeenCalledWith('update_booking_source', {
      p_booking_source_id: 'source-row-3',
      p_display_label: 'Updated website',
      p_allowed_origin: 'https://updated.example.test',
      p_is_active: true,
    });
  });

  it('builds public hosted and external URLs from opaque public source ids only', () => {
    const hosted = bookingSourcePublicUrl({
      source_kind: 'hosted',
      public_source_id: '11111111-1111-4111-8111-111111111111',
      public_path: '/forms/11111111-1111-4111-8111-111111111111',
    });
    const external = bookingSourcePublicUrl({
      source_kind: 'external',
      public_source_id: '22222222-2222-4222-8222-222222222222',
      public_path: null,
    });

    expect(hosted).toBe(`${DEFAULT_BOOKING_FORMS_ORIGIN}/forms/11111111-1111-4111-8111-111111111111`);
    expect(external).toBe(`${DEFAULT_BOOKING_FORMS_ORIGIN}/?source=22222222-2222-4222-8222-222222222222`);
    expect(`${hosted}${external}`).not.toContain('source_key');
    expect(`${hosted}${external}`).not.toContain('artist_id');
  });

  // A generated link is handed to a client, so the host it names is part of the
  // product. It used to be the internal workers.dev intake address, which no
  // browser could open as a form.
  it('generates client-facing links on the branded booking host, never workers.dev', () => {
    expect(DEFAULT_BOOKING_FORMS_ORIGIN).toBe('https://booking.vishartattoo.com');

    const hosted = bookingSourcePublicUrl({
      source_kind: 'hosted',
      public_source_id: '11111111-1111-4111-8111-111111111111',
      public_path: '/forms/11111111-1111-4111-8111-111111111111',
    });
    expect(hosted).not.toContain('workers.dev');
  });

  it('takes the booking origin from the build, and refuses anything but an owned host', () => {
    expect(readBookingFormsOrigin({})).toBe('https://booking.vishartattoo.com');
    expect(readBookingFormsOrigin({ VITE_BOOKING_FORMS_ORIGIN: '  ' })).toBe('https://booking.vishartattoo.com');
    expect(readBookingFormsOrigin({ VITE_BOOKING_FORMS_ORIGIN: 'https://intake-staging.vishartattoo.com' }))
      .toBe('https://intake-staging.vishartattoo.com');
    expect(readBookingFormsOrigin({ VITE_BOOKING_FORMS_ORIGIN: 'http://localhost:5173' }, true))
      .toBe('http://localhost:5173');

    for (const rejected of [
      'https://tattooai.vvetrov41.workers.dev',
      'https://booking.vishartattoo.com.evil.example',
      'http://booking.vishartattoo.com',
      'https://booking.vishartattoo.com/forms',
      'https://user:pass@booking.vishartattoo.com',
      'not a url',
    ]) {
      expect(() => readBookingFormsOrigin({ VITE_BOOKING_FORMS_ORIGIN: rejected })).toThrow();
    }

    // A loopback origin is a development convenience only.
    expect(() => readBookingFormsOrigin({ VITE_BOOKING_FORMS_ORIGIN: 'http://localhost:5173' })).toThrow();
  });
});
