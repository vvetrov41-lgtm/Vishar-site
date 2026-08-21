import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useArtistScope } from '../lib/artist-scope';
import { useApi, useSession } from '../lib/session';
import { BookingSourcesPage } from '../pages/BookingSourcesPage';

vi.mock('../lib/session', () => ({
  useApi: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock('../lib/artist-scope', () => ({
  useArtistScope: vi.fn(),
}));

vi.mock('../lib/i18n', () => ({
  useLanguage: () => ({ language: 'en' }),
}));

const ARTIST_ONE = 'a1111111-1111-4111-8111-111111111111';
const ARTIST_TWO = 'a2222222-2222-4222-8222-222222222222';
const PUBLIC_SOURCE = '91111111-1111-4111-8111-111111111111';

const artists = [
  { id: ARTIST_ONE, display_name: 'Artist One', slug: 'one', timezone: 'Europe/London', default_currency: 'GBP', is_active: true },
  { id: ARTIST_TWO, display_name: 'Artist Two', slug: 'two', timezone: 'Europe/London', default_currency: 'GBP', is_active: true },
];

function ownerSession() {
  return {
    profile: { role: 'owner' },
    memberships: [],
  } as any;
}

function artistScope(selectedArtistId: string | null = null) {
  return {
    artists,
    selectedArtistId,
    loading: false,
    error: false,
    setSelectedArtistId: vi.fn(),
  } as any;
}

function api(overrides: Record<string, unknown> = {}) {
  return {
    listBookingSources: vi.fn(async () => []),
    createBookingSource: vi.fn(async () => 'created-source'),
    updateBookingSource: vi.fn(async () => true),
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useSession).mockReturnValue(ownerSession());
  vi.mocked(useArtistScope).mockReturnValue(artistScope());
});

describe('Forms and websites management', () => {
  it('lists all manageable Artists explicitly and requires an Artist for creation in combined scope', async () => {
    const platform = api();
    vi.mocked(useApi).mockReturnValue(platform);

    render(<BookingSourcesPage />);

    expect(await screen.findByText('Add source')).toBeInTheDocument();
    expect(platform.listBookingSources).toHaveBeenCalledWith(undefined);
    expect(screen.getByLabelText('Booking source artist filter')).toHaveValue('');
    expect(screen.getByLabelText('Artist for new source')).toHaveValue('');
    expect(screen.getAllByRole('option', { name: 'Artist One' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('option', { name: 'Artist Two' }).length).toBeGreaterThan(0);
  });

  it('sends an external source create through the narrow RPC payload with exact Origin', async () => {
    const platform = api();
    vi.mocked(useApi).mockReturnValue(platform);

    render(<BookingSourcesPage />);
    await screen.findByText('Add source');

    fireEvent.change(screen.getByLabelText('Artist for new source'), { target: { value: ARTIST_TWO } });
    fireEvent.change(screen.getByLabelText('Source type'), { target: { value: 'external' } });
    fireEvent.change(screen.getByLabelText('Source label'), { target: { value: 'London website' } });
    fireEvent.change(screen.getByLabelText('Website HTTPS origin'), { target: { value: 'https://london.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create disabled' }));

    await waitFor(() => expect(platform.createBookingSource).toHaveBeenCalledWith({
      artistId: ARTIST_TWO,
      sourceKind: 'external',
      displayLabel: 'London website',
      allowedOrigin: 'https://london.example.test',
    }));
  });

  it('renders the hosted public URL without internal routing values', async () => {
    const platform = api({
      listBookingSources: vi.fn(async () => [{
        id: 'source-row',
        artist_id: ARTIST_ONE,
        public_source_id: PUBLIC_SOURCE,
        source_kind: 'hosted',
        display_label: 'Hosted London form',
        allowed_origin: null,
        form_template: 'tattoo-enquiry',
        form_version: 'booking-v1',
        is_active: true,
        public_path: `/forms/${PUBLIC_SOURCE}`,
        created_at: '2026-08-21T00:00:00Z',
        updated_at: '2026-08-21T00:00:00Z',
      }]),
    });
    vi.mocked(useApi).mockReturnValue(platform);

    render(<BookingSourcesPage />);

    const url = await screen.findByLabelText('Hosted London form public URL');
    expect(url).toHaveValue(`https://tattooai.vvetrov41.workers.dev/forms/${PUBLIC_SOURCE}`);
    expect(document.body.textContent).not.toContain('source_key');
    expect(document.body.textContent).not.toContain('artist_id');
  });

  it('fails closed before listing when a manager has no manageable Artist membership', () => {
    const platform = api();
    vi.mocked(useApi).mockReturnValue(platform);
    vi.mocked(useSession).mockReturnValue({
      profile: { role: 'booking_manager' },
      memberships: [{
        artist_id: ARTIST_ONE,
        is_active: true,
        can_manage_integrations: false,
      }],
    } as any);

    render(<BookingSourcesPage />);

    expect(screen.getByText('No access to form settings')).toBeInTheDocument();
    expect(platform.listBookingSources).not.toHaveBeenCalled();
  });
});
