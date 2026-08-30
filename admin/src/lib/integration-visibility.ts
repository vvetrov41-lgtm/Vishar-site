import type { Artist, ArtistMembership, Profile } from './types';

function normaliseIdentity(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLocaleLowerCase('en-GB')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * UI visibility for artist-owned integrations.
 *
 * Database/RPC permissions remain authoritative. The owner role is intentionally
 * narrowed here to the artist whose slug/display name matches the signed-in
 * profile, so one artist's ordinary integration surfaces do not expose another
 * artist's provider controls or status. A mismatch fails closed.
 */
export function canShowArtistIntegration(
  profile: Profile | null | undefined,
  artist: Pick<Artist, 'id' | 'slug' | 'display_name'>,
  memberships: ArtistMembership[],
): boolean {
  if (!profile?.is_active) return false;

  if (profile.role === 'owner') {
    const profileIdentity = normaliseIdentity(profile.display_name);
    if (!profileIdentity) return false;
    return normaliseIdentity(artist.slug) === profileIdentity
      || normaliseIdentity(artist.display_name) === profileIdentity;
  }

  return memberships.some(
    (membership) => membership.artist_id === artist.id
      && membership.is_active
      && membership.can_manage_integrations,
  );
}

export function visibleIntegrationArtistIds(
  profile: Profile | null | undefined,
  artists: Array<Pick<Artist, 'id' | 'slug' | 'display_name' | 'is_active'>>,
  memberships: ArtistMembership[],
): Set<string> {
  return new Set(
    artists
      .filter((artist) => artist.is_active && canShowArtistIntegration(profile, artist, memberships))
      .map((artist) => artist.id),
  );
}
