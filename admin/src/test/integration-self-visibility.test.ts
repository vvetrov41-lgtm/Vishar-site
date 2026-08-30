import { describe, expect, it } from 'vitest';
import {
  canShowArtistIntegration,
  visibleIntegrationArtistIds,
} from '../lib/integration-visibility';

const artists = [
  { id: 'artist-vladimir', slug: 'vladimir', display_name: 'Vladimir', is_active: true },
  { id: 'artist-kristina', slug: 'kristina', display_name: 'Kristina', is_active: true },
];

const bothMemberships = [
  {
    profile_id: 'profile-vladimir',
    artist_id: 'artist-vladimir',
    access_level: 'owner',
    can_view_finance: true,
    can_manage_finance: true,
    can_manage_sessions: true,
    can_manage_integrations: true,
    is_active: true,
  },
  {
    profile_id: 'profile-vladimir',
    artist_id: 'artist-kristina',
    access_level: 'owner',
    can_view_finance: true,
    can_manage_finance: true,
    can_manage_sessions: true,
    can_manage_integrations: true,
    is_active: true,
  },
];

describe('artist integration self-visibility', () => {
  it('shows an owner only their matching artist even when memberships cover both artists', () => {
    const profile = {
      id: 'profile-vladimir',
      display_name: 'Vladimir',
      role: 'owner',
      is_active: true,
    } as any;

    expect([
      ...visibleIntegrationArtistIds(profile, artists as any, bothMemberships as any),
    ]).toEqual(['artist-vladimir']);
    expect(canShowArtistIntegration(profile, artists[1] as any, bothMemberships as any)).toBe(false);
  });

  it('uses integration-management membership scope for non-owner staff', () => {
    const profile = {
      id: 'profile-manager',
      display_name: 'Booking manager',
      role: 'booking_manager',
      is_active: true,
    } as any;
    const memberships = [
      {
        ...bothMemberships[1],
        profile_id: 'profile-manager',
        access_level: 'manager',
      },
    ] as any;

    expect([
      ...visibleIntegrationArtistIds(profile, artists as any, memberships),
    ]).toEqual(['artist-kristina']);
  });

  it('fails closed when an owner profile cannot be matched to an artist identity', () => {
    const profile = {
      id: 'profile-owner',
      display_name: 'Studio owner',
      role: 'owner',
      is_active: true,
    } as any;

    expect([
      ...visibleIntegrationArtistIds(profile, artists as any, bothMemberships as any),
    ]).toEqual([]);
  });
});
